/**
 * 子会话清单：哪些会话文件是"派出去干的活"（派子会话 taba、/goal 的判官）。
 *
 * 为什么要单独记一份：历史会话列表、启动时自动打开最近会话，都得把子会话跳过去。
 * 以前是靠"第一条用户消息里有没有那句收尾要求"认的（见 tabaTask.TABA_CLOSING_MARK）——
 * 那等于让一份清单依赖某段文案，判官那种不走那套文案的子会话就漏了。
 * 派活的那一头本来就知道子会话的 .jsonl 路径（见 chatControllerBase），落一份到这里，
 * 读的那一头（sessionStore）查一下集合就知道，不用读文件内容。
 *
 * 文案那套留着当兜底：老会话（这个文件还不存在的时候建的）只有靠它才认得出来。
 *
 * 文件：<pichatDir>/child-sessions.json，内容形如 {"v":1,"files":["<绝对路径>", …]}。
 * 只记路径，别的一概不记 —— 那些（任务、结果、状态）在 taba-runs 名录里，两边各管各的。
 */
import * as fs from "fs";
import * as path from "path";
import { pichatDir } from "./serverPaths";

/** 文件格式版本；对不上就当作空清单（老版本插件写的东西不猜）。 */
const FILE_VERSION = 1;

/** 最多记这么多条：再老的那些文件早就被 pi 的清理或者人自己删了，记着也没用。 */
const MAX_ENTRIES = 300;

/** 清单在内存里的样子：全是规整过的键（见 {@link keyOf}）。 */
let known: Set<string> | undefined;

/** 清单文件路径。 */
export function childSessionsFile(dir: string = pichatDir()): string {
    return path.join(dir, "child-sessions.json");
}

/**
 * 比较用的键：绝对路径；Windows 上不分大小写（同一个文件 pi 有时给 `D:\…`、有时给 `d:\…`）。
 * 认不出来（空串）返回空串。
 */
function keyOf(file: string): string {
    const text = String(file || "").trim();
    if (!text) { return ""; }
    let abs: string;
    try {
        abs = path.resolve(text);
    } catch {
        return "";
    }
    return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** 读一次清单（读不着、坏掉、版本不对都当作空清单：这功能坏了不该拦着人看历史）。 */
function load(): Set<string> {
    const out = new Set<string>();
    try {
        const raw = JSON.parse(fs.readFileSync(childSessionsFile(), "utf8"));
        if (raw && raw.v === FILE_VERSION && Array.isArray(raw.files)) {
            for (const item of raw.files) {
                const key = typeof item === "string" ? keyOf(item) : "";
                if (key) { out.add(key); }
            }
        }
    } catch { /* 见上 */ }
    return out;
}

/** 确保清单已经读进内存（第一次用到时读一次）。 */
function ensureLoaded(): Set<string> {
    if (!known) { known = load(); }
    return known;
}

/** 这个会话文件是不是子会话（查清单，不读文件内容）。 */
export function isKnownChildSession(file: string): boolean {
    const key = keyOf(file);
    return key ? ensureLoaded().has(key) : false;
}

/**
 * 记下一个子会话文件（派活的那一头在拿到 .jsonl 路径以后调）。
 *
 * 已经在清单里就什么都不做（这个函数会被反复调：广播会话列表时顺手记一遍）。
 * 写盘失败不影响内存里那份 —— 这一次会话仍然认得出来，只是下次启动认不出。
 */
export function noteChildSession(file: string): boolean {
    const key = keyOf(file);
    if (!key) { return false; }
    const set = ensureLoaded();
    if (set.has(key)) { return false; }
    set.add(key);
    while (set.size > MAX_ENTRIES) {
        const oldest = set.values().next();
        if (oldest.done) { break; }
        set.delete(oldest.value);
    }
    save(set);
    return true;
}

/** 写回清单（先写临时文件再改名，写一半断电不会剩半份 JSON）。 */
function save(set: Set<string>): void {
    const file = childSessionsFile();
    const tmp = file + "." + process.pid + ".tmp";
    const body = JSON.stringify({ v: FILE_VERSION, files: Array.from(set) }, null, 0);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, body, "utf8");
        fs.renameSync(tmp, file);
    } catch {
        try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉就算了 */ }
    }
}
