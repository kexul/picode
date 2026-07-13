import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { agentDir } from "./modelsConfig";

/** 存放 pi 扩展（hook）的目录：~/.pi/agent/extensions/ */
export function extensionsDir(): string {
    return path.join(agentDir(), "extensions");
}

/** 工单记录目录：~/.pi/agent/ticket-logs/ */
export function ticketLogsDir(): string {
    return path.join(agentDir(), "ticket-logs");
}

/** 存放“各工作区当前激活工单”映射的目录：~/.pi/agent/ticket-active/ */
export function ticketActiveDir(): string {
    return path.join(agentDir(), "ticket-active");
}

/** 由 cwd 计算稳定的 key（用于 ticket-active 文件名，避免路径中的特殊字符）。 */
export function cwdKey(cwd: string): string {
    const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

/** 工单号必须以 # 加数字开头，例如 #12031。 */
export function isValidTicket(id: string): boolean {
    return /^#\d+/.test(id.trim());
}

/** 从工单标签中提取纯工单号（#12031 新增hook -> #12031）。 */
export function ticketId(label: string): string {
    const m = label.trim().match(/^#(\d+)/);
    return m ? "#" + m[1] : "";
}

/** 由工单号得到安全的日志文件名（如 #12031 -> 12031.md）。 */
function ticketLogFileName(id: string): string {
    return id.replace(/^#/, "").replace(/[^\w.-]/g, "_") + ".md";
}

/** 设置某工作区当前激活的工单（传入空标签则清除）。 */
export function setActiveTicket(cwd: string, label: string): void {
    const dir = ticketActiveDir();
    const file = path.join(dir, cwdKey(cwd) + ".json");
    try {
        fs.mkdirSync(dir, { recursive: true });
        const id = ticketId(label);
        if (!id) {
            try {
                fs.unlinkSync(file);
            } catch {
                /* ignore */
            }
            return;
        }
        fs.writeFileSync(
            file,
            JSON.stringify({ cwd, ticket: id, label: label.trim(), updatedAt: Date.now() }),
            "utf8"
        );
    } catch {
        /* ignore */
    }
}

/** 读取某工作区当前激活的工单标签（无则返回空串）。 */
export function getActiveTicket(cwd: string): string {
    const file = path.join(ticketActiveDir(), cwdKey(cwd) + ".json");
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return typeof data.label === "string" ? data.label : "";
    } catch {
        return "";
    }
}

/** 历史工单（按最近修改时间倒序）。从 ticket-logs 目录中的日志文件推导。 */
export function listTickets(): Array<{ id: string; label: string; mtime: number }> {
    const dir = ticketLogsDir();
    let files: string[] = [];
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const result: Array<{ id: string; label: string; mtime: number }> = [];
    for (const f of files) {
        if (!f.endsWith(".md")) {
            continue;
        }
        const full = path.join(dir, f);
        let mtime = 0;
        let label = "";
        try {
            const st = fs.statSync(full);
            if (!st.isFile()) {
                continue;
            }
            mtime = st.mtimeMs;
            // 首行形如：# 工单 #12031 新增hook
            const head = fs.readFileSync(full, "utf8").split(/\r?\n/, 1)[0] || "";
            const m = head.match(/#\d+.*/);
            if (m) {
                label = m[0].trim();
            }
        } catch {
            continue;
        }
        const id = "#" + f.replace(/\.md$/, "");
        result.push({ id, label: label || id, mtime });
    }
    result.sort((a, b) => b.mtime - a.mtime);
    return result;
}

/** 由本面板管理的 hook 文件头部标记，用于区分“我们创建的 hook”。 */
export const HOOK_MARKER = "// @pi-chat-hook";

export interface HookFile {
    /** 文件名（含 .ts 扩展名） */
    name: string;
    /** 绝对路径 */
    path: string;
    /** 完整源码 */
    content: string;
    /** 是否由本面板管理（含标记） */
    managed: boolean;
    /** 从文件里解析出的描述（第一行 // desc: ...） */
    description: string;
}

/** 校验 hook 名称是否安全（仅字母数字、连字符、下划线）。 */
export function isValidHookName(name: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(name);
}

/** 列出所有 hook 扩展文件（*.ts，忽略目录形式的扩展）。 */
export function listHooks(): HookFile[] {
    const dir = extensionsDir();
    let files: string[] = [];
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const hooks: HookFile[] = [];
    for (const f of files) {
        if (!f.endsWith(".ts")) {
            continue;
        }
        const full = path.join(dir, f);
        let content = "";
        try {
            if (!fs.statSync(full).isFile()) {
                continue;
            }
            content = fs.readFileSync(full, "utf8");
        } catch {
            continue;
        }
        hooks.push({
            name: f,
            path: full,
            content,
            managed: content.includes(HOOK_MARKER),
            description: parseDescription(content),
        });
    }
    hooks.sort((a, b) => a.name.localeCompare(b.name));
    return hooks;
}

/** 从源码解析描述：查找 `// desc: xxx`。 */
function parseDescription(content: string): string {
    const m = content.match(/\/\/\s*desc:\s*(.+)/);
    return m ? m[1].trim() : "";
}

/** 读取单个 hook 文件。 */
export function readHook(name: string): HookFile | undefined {
    if (!name.endsWith(".ts")) {
        name = name + ".ts";
    }
    const full = path.join(extensionsDir(), name);
    try {
        const content = fs.readFileSync(full, "utf8");
        return {
            name,
            path: full,
            content,
            managed: content.includes(HOOK_MARKER),
            description: parseDescription(content),
        };
    } catch {
        return undefined;
    }
}

/** 写入 hook 文件（自动创建目录）。name 不含 .ts 时自动补全。 */
export function writeHook(
    name: string,
    content: string
): { ok: boolean; error?: string; path?: string } {
    let base = name.endsWith(".ts") ? name.slice(0, -3) : name;
    if (!isValidHookName(base)) {
        return { ok: false, error: "名称仅允许字母、数字、连字符和下划线。" };
    }
    const full = path.join(extensionsDir(), base + ".ts");
    try {
        fs.mkdirSync(extensionsDir(), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
        return { ok: true, path: full };
    } catch (e: any) {
        return { ok: false, error: "写入失败: " + e.message };
    }
}

/** 删除 hook 文件。 */
export function deleteHook(name: string): { ok: boolean; error?: string } {
    if (!name.endsWith(".ts")) {
        name = name + ".ts";
    }
    const full = path.join(extensionsDir(), name);
    try {
        fs.unlinkSync(full);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: "删除失败: " + e.message };
    }
}

/**
 * 内置模板：LLM 删除文件/目录前询问用户同意。
 * 拦截 bash 工具里的 rm 命令，以及内置删除相关操作。
 */
export function confirmDeleteHookTemplate(): string {
    return `${HOOK_MARKER}
// desc: LLM 删除文件或目录前弹窗询问用户同意
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 检测一条 bash 命令是否包含删除文件/目录的操作。
 * 覆盖：rm / rmdir / unlink / find -delete / trash 等常见形式。
 */
function isDeleteCommand(command: string): boolean {
  if (!command) return false;
  // 按 ; && || | 换行拆分成子命令，逐条检查
  const segments = command.split(/[\\n;]|&&|\\|\\||\\|/);
  return segments.some((seg) => {
    const s = seg.trim();
    if (!s) return false;
    // rm / rmdir / unlink 作为命令开头（允许前面有 sudo）
    if (/^(sudo\\s+)?(rm|rmdir|unlink)\\b/.test(s)) return true;
    // find ... -delete
    if (/\\bfind\\b/.test(s) && /-delete\\b/.test(s)) return true;
    // find ... -exec rm
    if (/\\bfind\\b/.test(s) && /-exec\\s+rm\\b/.test(s)) return true;
    // trash / trash-put
    if (/^(sudo\\s+)?trash(-put)?\\b/.test(s)) return true;
    return false;
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // 只拦截 bash 工具的删除命令
    if (event.toolName !== "bash") return;
    const command: string = (event.input as any)?.command ?? "";
    if (!isDeleteCommand(command)) return;

    if (!ctx.hasUI) {
      // 无 UI（如 print 模式）时保守拦截
      return { block: true, reason: "删除操作需要用户确认，但当前无法弹窗。" };
    }

    const ok = await ctx.ui.confirm(
      "确认删除操作？",
      "LLM 想要执行删除命令：\\n\\n" + command + "\\n\\n是否允许？"
    );
    if (!ok) {
      return { block: true, reason: "用户拒绝了删除操作。" };
    }
  });
}
`;
}

/**
 * 内置模板：新对话首次交互时强制读取项目 rules（.mdc 文件）。
 * 读取 <cwd>/.codemaker/rules 与 <cwd>/.pi/rules 下所有 *.mdc，注入系统提示。
 */
export function loadRulesHookTemplate(): string {
    return `${HOOK_MARKER}
// desc: 新对话首次交互时强制读取 .codemaker/rules 和 .pi/rules 下的 *.mdc 规则
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 相对项目根目录的规则目录（存在才读取）
const RULE_DIRS = [".codemaker/rules", ".pi/rules"];

/** 递归收集目录下所有 .mdc 文件的绝对路径。 */
function collectMdcFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      results.push(...collectMdcFiles(full));
    } else if (st.isFile() && name.toLowerCase().endsWith(".mdc")) {
      results.push(full);
    }
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  // 每个会话（新对话/切换/fork）都重置注入标志
  let injected = false;
  pi.on("session_start", () => {
    injected = false;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // 只在本会话第一次交互时注入
    if (injected) return;
    injected = true;

    const cwd = ctx.cwd;
    const files: string[] = [];
    for (const rel of RULE_DIRS) {
      files.push(...collectMdcFiles(join(cwd, rel)));
    }
    if (files.length === 0) return; // 没有 rules 目录/文件则不处理

    const blocks: string[] = [];
    for (const file of files) {
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      blocks.push(\`===== RULE: \${file} =====\\n\${content}\`);
    }
    if (blocks.length === 0) return;

    const rulesText =
      "以下是本项目的强制规则（来自 .codemaker/rules 与 .pi/rules 的 .mdc 文件）。" +
      "在本次会话中你必须严格遵守这些规则：\\n\\n" +
      blocks.join("\\n\\n");

    if (ctx.hasUI) {
      ctx.ui.notify(\`已加载 \${blocks.length} 条项目规则\`, "info");
    }

    // 注入一条持久化消息（存入会话、发给 LLM）
    return {
      message: {
        customType: "project-rules",
        content: rulesText,
        display: true,
      },
    };
  });
}
`;
}

/**
 * 内置模板：按工单号缩略记录会话。
 * 当当前工作区选择/填入了工单（#数字）时，把每轮的用户消息与 LLM 回复
 * 缩略追加到 ~/.pi/agent/ticket-logs/<工单号>.md；未选工单则不处理。
 * 激活工单由 VSCode 插件写入 ~/.pi/agent/ticket-active/<cwd-key>.json。
 */
export function ticketLogHookTemplate(): string {
    return `${HOOK_MARKER}
// desc: 为会话选择/填入工单号时，按工单缩略记录每轮对话到全局目录
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function cwdKey(cwd: string): string {
  const norm = cwd.replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

// 读取当前工作区的激活工单标签（无则返回空串）
function readActiveTicket(cwd: string): string {
  const file = join(agentDir(), "ticket-active", cwdKey(cwd) + ".json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return typeof data.label === "string" ? data.label : "";
  } catch {
    return "";
  }
}

function ticketFile(label: string): string {
  const m = label.trim().match(/^#(\\d+)/);
  const id = m ? m[1] : "";
  return join(agentDir(), "ticket-logs", id.replace(/[^\\w.-]/g, "_") + ".md");
}

// 缩略文本：去除多余空白，超长截断
function brief(text: string, max = 400): string {
  const s = (text || "").replace(/\\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + " …(已缩略 " + (s.length - max) + " 字)";
}

// 从消息 content 中提取纯文本
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c && c.type === "text" ? c.text : ""))
      .join("");
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  let turn = 0;

  pi.on("turn_end", async (event, ctx) => {
    const label = readActiveTicket(ctx.cwd);
    if (!label) return; // 未选工单：不启用

    const msg: any = event.message;
    if (!msg || msg.role !== "assistant") return;

    // 本轮的 assistant 回复文本
    const reply = brief(textOf(msg.content));

    // 本轮对应的用户消息：从会话中倒找最近一条 user 消息
    let userText = "";
    try {
      const entries = ctx.sessionManager.getBranch();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e: any = entries[i];
        const m = e && (e.message || e);
        if (m && m.role === "user") {
          userText = brief(textOf(m.content));
          break;
        }
      }
    } catch {
      /* ignore */
    }

    if (!reply && !userText) return;

    turn += 1;
    const time = new Date().toLocaleString();
    const file = ticketFile(label);
    try {
      mkdirSync(join(agentDir(), "ticket-logs"), { recursive: true });
      // 文件不存在时写入标题头
      if (!existsSync(file)) {
        appendFileSync(file, "# " + label + "\\n\\n", "utf8");
      }
      let block = "## " + time + "\\n\\n";
      if (userText) block += "**我**: " + userText + "\\n\\n";
      if (reply) block += "**pi**: " + reply + "\\n\\n";
      appendFileSync(file, block, "utf8");
    } catch {
      /* ignore */
    }
  });
}
`;
}
