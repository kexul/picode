/**
 * 找文件：按文件名找、按文件里的文字找，以及「按一个写岔了的路径找那个文件」。
 *
 * 三样东西共用一份**会话目录的文件清单**（带缓存）：搜索框搜名字、搜内容，
 * 消息流里点一个只有光名字（或者路径写岔了）的链接，都从这份清单里挑。
 *
 * 清单怎么来：优先用 ripgrep（pi 自己就把一份放在 `<agent 目录>/bin/` 里，
 * 它自带的 grep / find 工具用的就是这一个），跑一遍 `rg --files`；
 * 这台机器上没有那份、PATH 里也没有时，退回自己在 Node 里走一遍目录——慢一点，但功能不缺席。
 * 搜内容同理：有 rg 就 `rg --vimgrep`，没有就自己逐个文件读。
 *
 * 这一层不碰 vscode、不碰网页服务，只认文件系统：后端、以后的命令行都能直接用。
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 内容搜索里一条命中：哪个文件、第几行、那一行长什么样。 */
export interface TextHit {
    /** 相对会话目录的写法，`/` 分隔 */
    path: string;
    line: number;
    text: string;
}

/** 一次搜索的结果（两种模式共用一份形状，用不上的那一半是空数组）。 */
export interface SearchOutcome {
    files: string[];
    hits: TextHit[];
    /** 结果被截断了（文件太多 / 命中太多 / 超时收手） */
    truncated: boolean;
    /** 没使上 ripgrep，是自己慢慢找的 */
    slow: boolean;
}

/** 一份文件清单：相对写法、`/` 分隔、按字符串排过序。 */
interface FileList {
    files: string[];
    truncated: boolean;
    slow: boolean;
}

/** 一口气列出来的文件上限：再多就不列了（够搜、也免得把一份清单撑爆内存）。 */
const MAX_LISTED_FILES = 100_000;
/** 会话目录里走一圈的定额（只在没有 rg 时用得上）。 */
const WALK_BUDGET_MS = 4_000;
/** 清单缓存的寿命：这段时间里反复打字 / 点链接都用同一份；过了再问一次盘。 */
const LIST_CACHE_MS = 5_000;
/** 同时留几个目录的清单（切会话、开几个项目时不至于无限攒着）。 */
const LIST_CACHE_DIRS = 4;
/** 列清单最多等这么久（大工程在慢盘上也就一两秒）。 */
const LIST_TIMEOUT_MS = 10_000;
/** 内容搜索最多等这么久：到点把 rg 杀掉，拿已经找到的那些。 */
const TEXT_TIMEOUT_MS = 5_000;
/** 内容搜索自己读文件时的定额。 */
const SLOW_SEARCH_BUDGET_MS = 4_000;
/** 跟 `/file` 那条地址同一个上限：超过 2 MB 的文件不当正文搜。 */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
/** 每条命中最多给这么长的一行（太长的行截断，页面也放不下）。 */
const MAX_HIT_TEXT = 300;
/** 一个文件最多算几条命中（同一行有好几处也只算一条）。 */
const MAX_HITS_PER_FILE = 2;

// ==================== ripgrep 在哪儿 ====================

/**
 * pi 放这些小工具的地方：`<agent 目录>/bin/`（rg、fd 都在那儿）。
 * 跟 pi 自己解这个目录的规矩一致：环境变量优先，否则就是家目录下的 `.pi/agent`。
 *（pi 把这个变量名按它自己的名字拼出来；默认名字是 pi，所以是 PI_CODING_AGENT_DIR。）
 */
function piBinDir(): string {
    const env = process.env.PI_CODING_AGENT_DIR;
    let agentDir: string;
    if (!env) {
        agentDir = path.join(os.homedir(), ".pi", "agent");
    } else if (env === "~") {
        agentDir = os.homedir();
    } else if (env.startsWith("~/") || env.startsWith("~\\")) {
        agentDir = path.join(os.homedir(), env.slice(2));
    } else {
        agentDir = env;
    }
    return path.join(agentDir, "bin");
}

/**
 * 找 ripgrep：先用 pi 那份，再认 PATH 里的 `rg`，都没有就是 null（退回自己走目录）。
 * 结果记下来：同一个进程里不用每回都去问一遍盘；ENOENT 之后也不再试。
 */
let rgCommand: string | null | undefined;

function resolveRg(): string | null {
    if (rgCommand !== undefined) { return rgCommand; }
    const exe = process.platform === "win32" ? "rg.exe" : "rg";
    const bundled = path.join(piBinDir(), exe);
    if (fs.existsSync(bundled)) {
        rgCommand = bundled;
        return bundled;
    }
    // 名字交给系统去 PATH 里找；真没有时 spawn 会报 ENOENT，那时再记成 null
    rgCommand = "rg";
    return "rg";
}

/** 起不来的 rg 别每次都试：记成没有，后面直接走慢速那条路。 */
function forgetRg(): void { rgCommand = null; }

interface RgRun {
    lines: string[];
    /** 找不到 rg 这个程序（是「没装」，不是「搜出错」） */
    missing: boolean;
    /** rg 跑了但报错（权限、参数写坏之类） */
    failed: boolean;
    /** 到上限 / 超时 / 被取消，提前收手了 */
    stopped: boolean;
}

/**
 * 跑一遍 rg，把标准输出的每一行收下来。
 *
 * 收够 `maxLines` 行、超时、取消（signal）都会把进程杀掉，已经收到的照旧给出去——
 * 搜索输入框里每敲一个字就发一次，前一次的结果没人要了，早停比等它跑完强。
 */
function runRg(exe: string, args: string[], cwd: string,
    opts: { maxLines: number; timeoutMs: number; signal?: AbortSignal }): Promise<RgRun> {
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            // stdin 一定要 ignore：不给路径时，rg 一看 stdin 是个管子就当「从管子读文本」，会一直等下去。
            child = spawn(exe, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch {
            resolve({ lines: [], missing: true, failed: false, stopped: false });
            return;
        }
        const lines: string[] = [];
        let buffer = "";
        let missing = false;
        let failed = false;
        let stopped = false;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            if (settled) { return; }
            settled = true;
            if (timer) { clearTimeout(timer); }
            opts.signal?.removeEventListener("abort", onAbort);
            resolve({ lines, missing, failed, stopped });
        };
        const stop = () => {
            stopped = true;
            try { child.kill(); } catch { /* 收不掉就算了 */ }
        };
        function onAbort() { stop(); }
        if (opts.signal) {
            if (opts.signal.aborted) {
                stop();
                finish();
                return;
            }
            opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        timer = setTimeout(() => { stop(); }, opts.timeoutMs);
        const take = (line: string) => {
            if (line === "" || stopped) { return; }
            lines.push(line);
            if (lines.length >= opts.maxLines) { stop(); }
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            if (settled || stopped) { return; }
            buffer += chunk;
            let at = buffer.indexOf("\n");
            while (at >= 0 && !stopped) {
                take(buffer.slice(0, at).replace(/\r$/, ""));
                buffer = buffer.slice(at + 1);
                at = buffer.indexOf("\n");
            }
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
            missing = err.code === "ENOENT";
            failed = !missing;
            finish();
        });
        child.on("close", () => {
            if (buffer && !stopped) { take(buffer.replace(/\r$/, "")); }
            finish();
        });
    });
}

// ==================== 文件清单（带缓存）====================

const listCache = new Map<string, { at: number; list: FileList }>();
const pendingLists = new Map<string, Promise<FileList>>();

/** 同一个目录同时来两次（打字快、点链接）只要问一遍盘。 */
function listSessionFiles(cwd: string): Promise<FileList> {
    const key = path.resolve(cwd);
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.at < LIST_CACHE_MS) { return Promise.resolve(hit.list); }
    const running = pendingLists.get(key);
    if (running) { return running; }
    const loading = loadList(key)
        .then((list) => {
            listCache.set(key, { at: Date.now(), list });
            if (listCache.size > LIST_CACHE_DIRS) {
                let oldestKey = key;
                let oldestAt = Infinity;
                for (const [k, v] of listCache) {
                    if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
                }
                if (oldestKey !== key) { listCache.delete(oldestKey); }
            }
            return list;
        })
        .finally(() => { pendingLists.delete(key); });
    pendingLists.set(key, loading);
    return loading;
}

/** 相对写法、`/` 分隔：界面和 `/dir` 那一圈地址都用这种写法。 */
function relativeTo(cwd: string, full: string): string {
    return path.relative(cwd, full).split(path.sep).join("/");
}

/** 有 rg 就跑它；跑不动就自己走目录。 */
async function loadList(cwd: string): Promise<FileList> {
    const rg = resolveRg();
    if (rg) {
        const run = await runRg(rg, [
            "--files",
            "--hidden",
            // 不是 git 仓库的目录也认 .gitignore（本项目的 dev/.scratch 这类就在仓库外面）
            "--no-require-git",
            // 版本库自己的东西永远不往里翻；node_modules 不管有没有写进 .gitignore 都跳过
            "--glob", "!**/.git/**",
            "--glob", "!**/node_modules/**",
            "--no-messages",
        ], cwd, { maxLines: MAX_LISTED_FILES, timeoutMs: LIST_TIMEOUT_MS });
        if (run.missing) {
            forgetRg();
        } else if (!run.failed) {
            const files = run.lines.map((line) => line.replace(/\\/g, "/")).filter((line) => line !== "");
            files.sort();
            return { files, truncated: run.stopped || files.length >= MAX_LISTED_FILES, slow: false };
        }
    }
    return walkFiles(cwd);
}

/** 没有 rg 时：自己在 Node 里把会话目录走一遍（跳过版本库和依赖目录，有定额）。 */
async function walkFiles(cwd: string): Promise<FileList> {
    const files: string[] = [];
    const pending = [cwd];
    const startedAt = Date.now();
    let seen = 0;
    let truncated = false;
    while (pending.length > 0) {
        const dir = pending.shift()!;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            seen += 1;
            if (seen > MAX_LISTED_FILES * 4 || Date.now() - startedAt > WALK_BUDGET_MS) {
                truncated = true;
                break;
            }
            if (entry.isDirectory()) {
                if (entry.name !== ".git" && entry.name !== "node_modules") {
                    pending.push(path.join(dir, entry.name));
                }
                continue;
            }
            if (!entry.isFile()) { continue; }
            files.push(relativeTo(cwd, path.join(dir, entry.name)));
            if (files.length >= MAX_LISTED_FILES) {
                truncated = true;
                break;
            }
        }
        if (truncated) { break; }
    }
    files.sort();
    return { files, truncated, slow: true };
}

// ==================== 按文件名找 ====================

/** 按文件名（也认路径里的字、也认「按顺序都出现」的模糊写法）挑一批，越像越靠前。 */
export async function findFileNames(cwd: string, query: string, limit = 200): Promise<SearchOutcome> {
    const list = await listSessionFiles(cwd);
    const q = query.trim().toLowerCase();
    if (!q) {
        return {
            files: list.files.slice(0, limit),
            hits: [],
            truncated: list.truncated || list.files.length > limit,
            slow: list.slow,
        };
    }
    const scored: Array<{ rel: string; score: number }> = [];
    for (const rel of list.files) {
        const score = nameScore(rel, q);
        if (score >= 0) { scored.push({ rel, score }); }
    }
    scored.sort((a, b) => a.score - b.score
        || a.rel.length - b.rel.length
        || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return {
        files: scored.slice(0, limit).map((item) => item.rel),
        hits: [],
        truncated: list.truncated || scored.length > limit,
        slow: list.slow,
    };
}

/**
 * 一条相对路径跟关键词有多像：越小越靠前，-1 表示不像。
 *
 * 顺序：文件名一模一样 → 文件名开头 → 文件名里有一段 → 路径里有一段 →
 * 文件名里按顺序都能找到（模糊）。路径上不再做模糊：一条 `pichat/…` 会被 "chat" 按顺序命中，
 * 满屏都是这种，把真正叫 chat 的文件挤下去了。
 */
function nameScore(rel: string, q: string): number {
    const lower = rel.toLowerCase();
    const slash = lower.lastIndexOf("/");
    const name = slash < 0 ? lower : lower.slice(slash + 1);
    if (name === q) { return 0; }
    if (name.startsWith(q)) { return 1; }
    const at = name.indexOf(q);
    if (at >= 0) { return 2 + at / 1000; }
    if (lower.includes(q)) { return 10; }
    if (isSubsequence(name, q)) { return 20; }
    return -1;
}

/** 关键词的每个字符都在 text 里按顺序出现（不用挨着）。 */
function isSubsequence(text: string, q: string): boolean {
    let at = 0;
    for (let i = 0; i < text.length && at < q.length; i += 1) {
        if (text[i] === q[at]) { at += 1; }
    }
    return at === q.length;
}

// ==================== 按内容找 ====================

/**
 * 在文件内容里找（按字面找、不分大小写），给出文件 + 行号 + 那一行。
 * 有 rg 就走它；没有（或它跑不动）就自己逐个文件读。
 */
export async function findFileContents(cwd: string, query: string, limit = 200,
    signal?: AbortSignal): Promise<SearchOutcome> {
    const q = query.trim();
    if (!q) {
        return { files: [], hits: [], truncated: false, slow: false };
    }
    const rg = resolveRg();
    if (rg) {
        const run = await runRg(rg, [
            "--vimgrep",
            "--no-heading",
            "--fixed-strings",
            "--ignore-case",
            "--hidden",
            "--no-require-git",
            "--glob", "!**/.git/**",
            "--glob", "!**/node_modules/**",
            "--max-count", String(MAX_HITS_PER_FILE),
            "--max-filesize", "2M",
            "--max-columns", "400",
            "--max-columns-preview",
            "--no-messages",
            "-e", q,
        ], cwd, { maxLines: limit * 2, timeoutMs: TEXT_TIMEOUT_MS, signal });
        if (run.missing) {
            forgetRg();
        } else if (!run.failed) {
            const hits = parseVimgrep(run.lines, limit);
            // rg 给的是它走目录的顺序：排一下，同样的搜索每次结果一样，看着不飘
            hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
            return { files: [], hits, truncated: run.stopped || hits.length >= limit, slow: false };
        }
    }
    return searchContentsSlowly(cwd, q, limit, signal);
}

/** `路径:行:列:那一行`（rg --vimgrep 的写法）；同一个文件的同一行只留一条。 */
function parseVimgrep(lines: string[], limit: number): TextHit[] {
    const hits: TextHit[] = [];
    const seen = new Set<string>();
    // 第一个冒号可能是盘符（`C:\…`），所以是「找到冒号后面紧跟数字」那一段才算
    const pattern = /^(.*?):(\d+):(\d+):(.*)$/;
    for (const line of lines) {
        const matched = pattern.exec(line);
        if (!matched) { continue; }
        const rel = matched[1].replace(/\\/g, "/");
        const lineNo = Number(matched[2]);
        const key = rel + "\0" + lineNo;
        if (seen.has(key)) { continue; }
        seen.add(key);
        hits.push({ path: rel, line: lineNo, text: matchesText(matched[4]) });
        if (hits.length >= limit) { break; }
    }
    return hits;
}

function matchesText(text: string): string {
    return text.length > MAX_HIT_TEXT ? text.slice(0, MAX_HIT_TEXT) : text;
}

/** 没有 rg 时：拿文件清单逐个读，边读边找（有定额，时间到了就拿手头这些）。 */
async function searchContentsSlowly(cwd: string, q: string, limit: number,
    signal?: AbortSignal): Promise<SearchOutcome> {
    const list = await listSessionFiles(cwd);
    const needle = q.toLowerCase();
    const hits: TextHit[] = [];
    const startedAt = Date.now();
    let truncated = list.truncated;
    for (const rel of list.files) {
        if (signal?.aborted) { truncated = true; break; }
        if (hits.length >= limit) { truncated = true; break; }
        if (Date.now() - startedAt > SLOW_SEARCH_BUDGET_MS) { truncated = true; break; }
        const full = path.join(cwd, rel);
        let stat: fs.Stats;
        try { stat = await fs.promises.stat(full); } catch { continue; }
        if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) { continue; }
        let text: string;
        try { text = await fs.promises.readFile(full, "utf8"); } catch { continue; }
        // 二进制文件（有 NUL）当文字搜没有意义
        if (text.includes("\0")) { continue; }
        const lines = text.split(/\r?\n/);
        let found = 0;
        for (let i = 0; i < lines.length && found < MAX_HITS_PER_FILE; i += 1) {
            if (!lines[i].toLowerCase().includes(needle)) { continue; }
            hits.push({ path: rel, line: i + 1, text: matchesText(lines[i]) });
            found += 1;
            if (hits.length >= limit) { truncated = true; break; }
        }
    }
    return { files: [], hits, truncated, slow: true };
}

// ==================== 按一个写岔了的路径找那个文件 ====================

/**
 * 消息流里的文件链接只有光名字（`chat.js`）、或者路径写岔了（`src/chat.js` 写成 `lib/chat.js`）时，
 * 在会话目录的清单里挑最像的那一个：
 *   - 先找尾巴对上的（`media/chat.js` 这种写法对上整条相对路径）；
 *   - 再找浅的（`a/chat.js` 赢过 `a/b/c/chat.js`）；
 *   - 名字要一模一样（大小写也算），不猜。
 * 清单读不到时给 undefined（调用方当「没找到」处理）。
 */
export async function findListedFile(cwd: string, wantPath: string): Promise<string | undefined> {
    const list = await listSessionFiles(cwd);
    const want = String(wantPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const base = want.split("/").pop() || "";
    if (!base) { return undefined; }
    let best: string | undefined;
    let bestTail = false;
    let bestDepth = Infinity;
    let bestLength = Infinity;
    for (const rel of list.files) {
        const slash = rel.lastIndexOf("/");
        const name = slash < 0 ? rel : rel.slice(slash + 1);
        if (name !== base) { continue; }
        const tail = rel === want || rel.endsWith("/" + want);
        const depth = rel.split("/").length;
        // 尾巴对上的总是赢（旧做法也是：一边找一边记着只对上名字的那一个，尾巴对上的立刻用）；
        // 同一种里再比深浅、再比长短（清单是排过序的，长短也一样时先到的那个留下）。
        const better = best === undefined
            || (tail && !bestTail)
            || (tail === bestTail && (depth < bestDepth || (depth === bestDepth && rel.length < bestLength)));
        if (better) {
            best = rel;
            bestTail = tail;
            bestDepth = depth;
            bestLength = rel.length;
        }
    }
    return best;
}
