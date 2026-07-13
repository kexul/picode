import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SessionInfo {
    file: string; // 绝对路径
    id: string; // session uuid
    mtime: number; // 修改时间（用于排序）
    title: string; // 展示标题
    messageCount: number;
    name?: string; // 用户设置的会话名
}

/** pi 配置目录，遵循 PI_CODING_AGENT_DIR 环境变量。 */
function agentDir(): string {
    return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** pi 会话根目录，遵循 PI_CODING_AGENT_SESSION_DIR 环境变量。 */
function sessionsRoot(): string {
    return (
        process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir(), "sessions")
    );
}

/** 将 cwd 转换为 pi 使用的目录名。
 * pi 的规则：把路径中的分隔符（/ 、 \ 、 :）都替换为 `-`，两端加 `--`。
 * 例如 `D:\BackUp\pi_plugin` -> `--D--BackUp-pi_plugin--`（冒号和反斜杠都变 `-`，因此 `D:` 后成为 `--`）。
 */
function encodeCwd(cwd: string): string {
    const dashed = cwd.replace(/[\\/:]/g, "-");
    return "--" + dashed + "--";
}

/** 从一段 content（string 或 content blocks）提取纯文本。 */
function contentToText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((b: any) => (b && b.type === "text" ? b.text : ""))
            .join("")
            .trim();
    }
    return "";
}

/**
 * 读取指定 cwd 对应的所有 pi 会话，按最近修改时间倒序返回。
 * 只读取每个文件的少量行以获取标题，避免解析大文件全部内容。
 */
export function listSessions(cwd: string): SessionInfo[] {
    // 尝试多种盘符大小写（VSCode 在 Windows 上可能返回小写盘符）。
    const candidates = new Set<string>([cwd]);
    const m = cwd.match(/^([a-zA-Z])(:)/);
    if (m) {
        candidates.add(m[1].toUpperCase() + cwd.slice(1));
        candidates.add(m[1].toLowerCase() + cwd.slice(1));
    }

    let dir: string | undefined;
    for (const c of candidates) {
        const d = path.join(sessionsRoot(), encodeCwd(c));
        try {
            if (fs.existsSync(d)) {
                dir = d;
                break;
            }
        } catch {
            /* ignore */
        }
    }
    if (!dir) {
        return [];
    }

    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
        return [];
    }

    const sessions: SessionInfo[] = [];
    for (const f of files) {
        const full = path.join(dir, f);
        try {
            const stat = fs.statSync(full);
            const info = parseSessionHead(full);
            sessions.push({
                file: full,
                id: info.id,
                mtime: stat.mtimeMs,
                title: info.name || info.firstUserText || "(空会话)",
                messageCount: info.messageCount,
                name: info.name,
            });
        } catch {
            /* 跳过无法读取的文件 */
        }
    }

    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions;
}

interface SessionHead {
    id: string;
    firstUserText: string;
    name?: string;
    messageCount: number;
}

/** 逐行解析会话文件，提取标题所需的少量信息。 */
function parseSessionHead(file: string): SessionHead {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let id = "";
    let firstUserText = "";
    let name: string | undefined;
    let messageCount = 0;

    for (const line of lines) {
        const t = line.trim();
        if (!t) {
            continue;
        }
        let entry: any;
        try {
            entry = JSON.parse(t);
        } catch {
            continue;
        }
        if (entry.type === "session") {
            id = entry.id || "";
        } else if (entry.type === "session_info" && entry.name) {
            name = entry.name;
        } else if (entry.type === "message" && entry.message) {
            const role = entry.message.role;
            if (role === "user" || role === "assistant") {
                messageCount++;
            }
            if (!firstUserText && role === "user") {
                firstUserText = contentToText(entry.message.content).replace(/\s+/g, " ").slice(0, 80);
            }
        }
    }

    return { id, firstUserText, name, messageCount };
}
