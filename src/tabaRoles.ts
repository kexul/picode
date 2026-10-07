/**
 * 派子会话（taba）：角色文件（agents 目录下那些 .md）的读取与解析。
 *
 * 一个角色文件长这样（前置元数据 + 正文，正文就是这个角色的说明书，会交给子会话）：
 *
 *     ---
 *     name: scout
 *     description: 只读的摸底
 *     tools: read, bash
 *     session-mode: standalone
 *     ---
 *
 *     你是摸底角色……
 *
 * 字段名跟 hazat/pi-interactive-subagents 那份保持一致，所以你已有的角色文件能直接用。
 * 我们只认用得上的字段，认不出的字段原样忽略。
 *
 * 同名角色的优先级：项目里的 .pi/agents/ > 全局 ~/.pi/agent/agents/ > 插件自带的默认角色。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 子会话的会话内容从哪来。 */
export type TabaSessionMode = "standalone" | "lineage-only" | "fork";

/** 角色来自哪个目录。 */
export type TabaRoleOrigin = "project" | "global" | "builtin";

export interface TabaRole {
    name: string;
    description: string;
    /** 指定模型（可以写成 provider/model）；空表示跟随派活的那个会话。 */
    model?: string;
    /** 指定思考强度。 */
    thinking?: string;
    /** 工具白名单，已归一化成 `read,bash` 这种没有空格的形式。 */
    tools?: string;
    /** 要自动加载的技能名，已归一化成 `a,b`。 */
    skills?: string;
    sessionMode?: TabaSessionMode;
    /** 正文怎么给子会话：追加到系统提示词后面 / 整个换掉系统提示词；不给就跟在任务文本里。 */
    systemPromptMode?: "append" | "replace";
    /** 子会话的工作目录（相对项目根或绝对路径）。 */
    cwd?: string;
    /** 正文（说明书）。 */
    body: string;
    origin: TabaRoleOrigin;
    /** 角色文件路径。 */
    filePath: string;
    /** 不给它写原因：这个角色我们的 tab 跑不了（例如声明了要用外部命令行工具）。 */
    unusable?: string;
    /** 不在角色列表里显示；指名派活仍然可以。 */
    hidden?: boolean;
}

/** 解析出来的前置元数据（键值对）。 */
export interface RoleFrontmatter {
    [key: string]: string;
}

/** pi 的配置目录（遵循它自己的环境变量）。 */
export function piAgentDir(): string {
    return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** 三个角色目录，按优先级从高到低排。 */
export function roleDirs(projectDir: string, bundledDir?: string, agentDir?: string): Array<{ dir: string; origin: TabaRoleOrigin }> {
    const globalDir = path.join(agentDir ?? piAgentDir(), "agents");
    const out: Array<{ dir: string; origin: TabaRoleOrigin }> = [];
    if (projectDir) { out.push({ dir: path.join(projectDir, ".pi", "agents"), origin: "project" }); }
    out.push({ dir: globalDir, origin: "global" });
    if (bundledDir) { out.push({ dir: bundledDir, origin: "builtin" }); }
    return out;
}

/** 把 `read, bash` 这种列表归一化成 `read,bash`；空列表返回 undefined。 */
export function normalizeListValue(raw?: string): string | undefined {
    if (!raw) { return undefined; }
    const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) { return undefined; }
    // 去重但保持顺序（角色文件里写重了也不至于传两个一样的）
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of items) {
        const key = it.toLowerCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(it);
    }
    return out.join(",");
}

/** 去掉值两端的引号（单引号或双引号都要，只去一层）。 */
function unquote(v: string): string {
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        return v.slice(1, -1).trim();
    }
    return v;
}

/**
 * 解析一份角色文件的文本：前置元数据 + 正文。
 *
 * 没有前置元数据时也能用：整份文件当正文，名字用文件名。
 * @param text 文件内容
 * @param fallbackName 文件名（不含 .md），没有 name 字段时用它
 */
export function parseRoleMarkdown(text: string, fallbackName: string, origin: TabaRoleOrigin, filePath: string): TabaRole | undefined {
    const raw = text.replace(/^\uFEFF/, "");
    const { front, body } = splitFrontmatter(raw);
    const name = unquote(front.name || fallbackName).trim();
    if (!name) { return undefined; }
    const role: TabaRole = {
        name,
        description: unquote(front.description || "").trim(),
        body: body.trim(),
        origin,
        filePath,
    };
    const model = unquote(front.model || "");
    if (model) { role.model = model; }
    const thinking = unquote(front.thinking || "");
    if (thinking) { role.thinking = thinking; }
    const tools = normalizeListValue(unquote(front.tools || ""));
    if (tools) { role.tools = tools; }
    const skills = normalizeListValue(unquote(front.skills || ""));
    if (skills) { role.skills = skills; }
    const mode = unquote(front["session-mode"] || "").trim();
    if (mode === "standalone" || mode === "lineage-only" || mode === "fork") { role.sessionMode = mode; }
    const sp = unquote(front["system-prompt"] || "").trim().toLowerCase();
    if (sp === "append" || sp === "replace") { role.systemPromptMode = sp; }
    const cwd = unquote(front.cwd || "");
    if (cwd) { role.cwd = cwd; }
    if ("runner" in front) {
        role.unusable = "这个角色声明了要用外部命令行工具跑，我们的 tab 只能跑 pi";
    }
    const hide = unquote(front["disable-model-invocation"] || "").trim().toLowerCase();
    if (hide === "true" || hide === "yes") { role.hidden = true; }
    return role;
}

/** 把文本切成前置元数据（键值对）与正文两段。没有元数据时 front 是空对象。 */
export function splitFrontmatter(text: string): { front: RoleFrontmatter; body: string } {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || lines[0].trim() !== "---") {
        return { front: {}, body: text };
    }
    const front: RoleFrontmatter = {};
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "---") {
            return { front, body: lines.slice(i + 1).join("\n") };
        }
        const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) { continue; }
        // 同名键以第一次出现的为准（缩进的子键我们不需要，但也不能把值覆盖掉）
        if (!(m[1] in front)) { front[m[1]] = m[2].trim(); }
    }
    // 没找到收尾的 ---：整个文件当正文，避免把说明书吃掉
    return { front: {}, body: text };
}

/** 列出目录下的 .md 文件名（目录不存在返回空数组）。 */
export function listRoleFiles(dir: string): string[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.toLowerCase().endsWith(".md"))
        .sort();
}

/**
 * 读齐三个目录里的角色，按优先级去重（项目 > 全局 > 插件自带）。
 * 读文件失败的那份跳过，不影响其他角色。
 */
export function loadRoles(projectDir: string, bundledDir?: string, agentDir?: string): TabaRole[] {
    const out: TabaRole[] = [];
    for (const { dir, origin } of roleDirs(projectDir, bundledDir, agentDir)) {
        for (const file of listRoleFiles(dir)) {
            const full = path.join(dir, file);
            let text: string;
            try {
                text = fs.readFileSync(full, "utf8");
            } catch {
                continue;
            }
            const fallback = file.slice(0, -3);
            const role = parseRoleMarkdown(text, fallback, origin, full);
            if (!role) { continue; }
            out.push(role);
        }
    }
    return dedupeRoles(out);
}

/** 同名角色只留第一次出现的那个（数组要按优先级从高到低排）。 */
export function dedupeRoles(roles: TabaRole[]): TabaRole[] {
    const seen = new Set<string>();
    const out: TabaRole[] = [];
    for (const r of roles) {
        const key = r.name.toLowerCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(r);
    }
    return out;
}

/** 按名字找角色：大小写不敏感，允许把 .md 后缀一起写进来。 */
export function pickRoleByName(roles: TabaRole[], name: string): TabaRole | undefined {
    const want = name.trim().toLowerCase().replace(/\.md$/, "");
    if (!want) { return undefined; }
    for (const r of roles) {
        if (r.name.toLowerCase() === want) { return r; }
    }
    return undefined;
}

/** 能给模型看的角色清单（跑得不了的、刻意藏起来的都不列）。 */
export function listableRoles(roles: TabaRole[]): TabaRole[] {
    return roles.filter((r) => !r.unusable && !r.hidden);
}
