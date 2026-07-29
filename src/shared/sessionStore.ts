import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

export interface SessionInfo {
    file: string; // 绝对路径
    id: string; // session uuid
    mtime: number; // 修改时间（用于排序）
    title: string; // 展示标题
    messageCount: number;
    name?: string; // 用户设置的会话名
    userTexts: string[]; // 所有 user 消息预览（按时序）
    topFile?: string; // 改动最多的文件 basename
    topFileCount?: number; // 该文件的改动次数
    totalFiles?: number; // 不重复的改动文件总数
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

/** 从 edit/write 工具调用的 arguments 中取出目标路径，返回 basename 用于标题统计。 */
function toolCallBasename(args: any): string | null {
    const raw =
        typeof args?.path === "string"
            ? args.path
            : typeof args?.file_path === "string"
              ? args.file_path
              : null;
    if (!raw) {
        return null;
    }
    // 统一分隔符后取末段作 basename，避免 Windows/Unix 路径差异。
    const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * 读取指定 cwd 对应的所有 pi 会话，按最近修改时间倒序返回。
 * 只读取每个文件的少量行以获取标题，避免解析大文件全部内容。
 */
export async function listSessions(cwd: string): Promise<SessionInfo[]> {
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

    // 并发流式解析各会话文件的头部信息，避免一次性把整个文件读进内存。
    const entries = await Promise.all(
        files.map(async (f) => {
            const full = path.join(dir, f);
            try {
                const stat = fs.statSync(full);
                const info = await parseSessionHead(full);
                const top = info.fileStats[0];
                return {
                    file: full,
                    id: info.id,
                    mtime: stat.mtimeMs,
                    title: buildTitle(info),
                    messageCount: info.messageCount,
                    name: info.name,
                    userTexts: info.userTexts,
                    topFile: top?.name,
                    topFileCount: top?.count,
                    totalFiles: info.totalEdits,
                } as SessionInfo;
            } catch {
                return null;
            }
        })
    );
    const sessions = entries.filter((s): s is SessionInfo => s !== null);

    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions;
}

/** 生成展示标题：用户命名 > 改动最多的文件 > 首条 user 消息 > 空会话。 */
function buildTitle(info: SessionHead): string {
    if (info.name) {
        return info.name;
    }
    const top = info.fileStats[0];
    if (top) {
        if (info.totalEdits > 1) {
            return `${top.name}（改 ${top.count} 次，共 ${info.totalEdits} 个文件）`;
        }
        return `${top.name}（改 ${top.count} 次）`;
    }
    return info.firstUserText || "(空会话)";
}

interface SessionHead {
    id: string;
    firstUserText: string;
    userTexts: string[];
    name?: string;
    messageCount: number;
    fileStats: { name: string; count: number }[]; // edit/write 改动文件按次数倒序
    totalEdits: number; // 不重复文件数
}

/**
 * 按行流式解析会话文件，提取标题所需的少量信息。
 * 使用 createReadStream + readline，避免把整个会话文件读入内存后
 * 再 `split("\n")` 生成大数组（大会话文件可达数 MB）。
 */
function parseSessionHead(file: string): Promise<SessionHead> {
    return new Promise((resolve) => {
        let id = "";
        let firstUserText = "";
        const userTexts: string[] = [];
        let name: string | undefined;
        let messageCount = 0;
        const fileCounts = new Map<string, number>();

        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8" });
        } catch {
            resolve({ id, firstUserText, userTexts, name, messageCount, fileStats: [], totalEdits: 0 });
            return;
        }

        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on("line", (line: string) => {
            const t = line.trim();
            if (!t) {
                return;
            }
            let entry: any;
            try {
                entry = JSON.parse(t);
            } catch {
                return;
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
                if (role === "user") {
                    const ut = contentToText(entry.message.content).replace(/\s+/g, " ");
                    if (!firstUserText) {
                        firstUserText = ut.slice(0, 80);
                    }
                    if (ut) {
                        userTexts.push(ut.slice(0, 150));
                    }
                }
                // 统计 edit/write 工具调用的目标文件，用于生成“改动最多的文件”标题。
                if (role === "assistant" && Array.isArray(entry.message.content)) {
                    for (const c of entry.message.content) {
                        if (c && c.type === "toolCall" && (c.name === "edit" || c.name === "write")) {
                            const bn = toolCallBasename(c.arguments);
                            if (bn) {
                                fileCounts.set(bn, (fileCounts.get(bn) || 0) + 1);
                            }
                        }
                    }
                }
            }
        });

        const done = () => {
            const fileStats = Array.from(fileCounts.entries())
                .map(([n, c]) => ({ name: n, count: c }))
                .sort((a, b) => b.count - a.count);
            resolve({ id, firstUserText, userTexts, name, messageCount, fileStats, totalEdits: fileCounts.size });
        };
        rl.on("close", done);
        rl.on("error", done);
        stream.on("error", done);
    });
}
