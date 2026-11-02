/**
 * 「改动」那一格的数据源：直接问会话目录所在的 git 仓库，什么都不另存。
 *
 * 口径是「最近一次提交 → 现在磁盘上的样子」：`git diff HEAD` 那一份，加上还没被 git 收下的
 * 新文件（`git ls-files --others`，`.gitignore` 忽略的不算）。模型用 `edit` / `write` 改的、
 * `bash` 里跑的脚本和命令（`sed -i`、构建、`rm`）改的都一样在里面 —— 它们最后都落在磁盘上，
 * 而 git 只认磁盘。所以这一格答的是「这个目录相对它最后一次提交差了什么」，不是
 * 「这个会话改了什么」：会话开始之前就有、还没提交的改动也算在里面。
 *
 * 会话目录不在 git 仓库里（或者没装 git）时什么都不给：那一格整格收起来（见 media/chat.js）。
 * 点开一份 diff 时横条上那颗「回滚」也是这个口径：把这个文件撤到最近一次提交
 * （提交里没有它就删掉），不是撤到会话开始那一刻。
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { diffCounts, makeUnifiedDiff } from "./messageUtils";
import { pichatDir } from "./serverPaths";

/** 「改动」那一格里的一行：这个会话目录把一个文件改成了什么样。 */
export interface SessionChangeInfo {
    /** 相对会话目录的写法（跟文件链接里的写法一样）。 */
    path: string;
    added: number;
    removed: number;
    /** 文件已经不在了（删掉了）。 */
    deleted: boolean;
    /** 太大，没法在这一格里比（不给增删行数，也看不到 diff）。 */
    tooBig: boolean;
}

/** `/changes` 回的那一份：vcs=false 表示会话目录不在 git 仓库里（那一格整格收起来）。 */
export interface SessionChanges {
    vcs: boolean;
    changes: SessionChangeInfo[];
}

/** 单个文件愿意比的文本上限：超过它只标「看不了」（本来也画不出 diff）。 */
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;
/** 一份 diff 的行数上限：再多就不往页面上拖了（那一行标成「看不了」）。 */
const MAX_DIFF_LINES = 20_000;
/** 每条命令都带上的配置：别按平台改行尾、路径别转义成八进制、别自动打包。 */
const GIT_FLAGS = [
    "-c", "core.autocrlf=false",
    "-c", "core.safecrlf=false",
    "-c", "core.quotepath=false",
    "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0",
];
const ASK_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 20_000;

/** 在会话目录里跑一条 git 命令；失败不抛，返回 ok=false（调用方按「这次算不出来」处理）。 */
function runGit(workTree: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
        execFile("git", [...GIT_FLAGS, ...args], {
            cwd: workTree,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
            encoding: "utf8",
        }, (err, stdout) => resolve({ ok: !err, stdout: typeof stdout === "string" ? stdout : "" }));
    });
}

/** 界面报上来的是相对写法：只认会话目录往里走的那些（绝对路径、`..` 一律不认）。 */
function safeRel(relPath: string): boolean {
    if (!relPath || path.isAbsolute(relPath)) { return false; }
    return !relPath.split(/[\\/]/).some((one) => one === "..");
}

/** 一段 diff 文字是不是太长了（太长的清单那一行标成看不了，别往页面上拖）。 */
function tooManyDiffLines(diff: string): boolean {
    let lines = 0;
    for (let i = 0; i < diff.length; i++) {
        if (diff.charCodeAt(i) === 10 && ++lines > MAX_DIFF_LINES) { return true; }
    }
    return false;
}

/**
 * 只留 `@@` 往下的那几段（界面现成的画法只认这个形状：`+` 加、`-` 删、其余是没变的）。
 * git 自己那几行头（`diff --git`、`index`、`---`、`+++`）留着会被当成改动画上颜色。
 * 二进制那种（没有 `@@`）就什么都不给。
 */
function hunksOnly(diff: string): string {
    const lines = diff.split("\n");
    const at = lines.findIndex((line) => line.startsWith("@@"));
    return at < 0 ? "" : lines.slice(at).join("\n");
}

/**
 * 老版本在 `PICHAT_HOME` 下给每个会话建过一个影子仓库（`shadow/`）。现在不建了，
 * 以前留下的那些是异常退出没删干净的：第一次用到这一格时整个删掉（那个目录按契约随时可以整个删）。
 * 进程里只试一次。
 */
let legacyDropped = false;
function dropLegacyShadowDirs(): void {
    if (legacyDropped) { return; }
    legacyDropped = true;
    try { fs.rmSync(path.join(pichatDir(), "shadow"), { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

/** 会话目录在不在 git 仓库里。不在里面时「改动」那一格没有数据源（整格收起来）。 */
export async function inGitRepo(workTree: string): Promise<boolean> {
    const r = await runGit(workTree, ["rev-parse", "--is-inside-work-tree"], ASK_TIMEOUT_MS);
    return r.ok && r.stdout.trim() === "true";
}

/**
 * 这个会话目录相对它最后一次提交差了什么（一行一个文件，按路径排）。
 * @returns undefined = 会话目录不在 git 仓库里（调用方按「整格收起来」处理）
 */
export async function listChanges(workTree: string): Promise<SessionChanges | undefined> {
    dropLegacyShadowDirs();
    if (!(await inGitRepo(workTree))) { return undefined; }
    const out: SessionChangeInfo[] = [];
    const seen = new Set<string>();
    // --relative：只看会话目录这一层（写法也按这一层算，不用自己换算）。
    // --ignore-cr-at-eol：整份行尾从 LF 变成 CRLF（Windows 上仓库按 CRLF 检出、编辑工具按 LF
    // 写回去，很常见）不算改动。不加这个，内容一个字没改的文件会报成整份重写（+2033 −2034）。
    const numstat = await runGit(workTree,
        ["diff", "--numstat", "--no-renames", "--ignore-cr-at-eol", "--relative", "-z", "HEAD"], LIST_TIMEOUT_MS);
    // 一次提交都还没有的仓库里 HEAD 不存在：那一份空的，新文件由下面那段补上
    if (numstat.ok) {
        for (const record of numstat.stdout.split("\0")) {
            if (!record) { continue; }
            const first = record.indexOf("\t");
            const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
            if (first < 0 || second < 0) { continue; }
            const addText = record.slice(0, first);
            const delText = record.slice(first + 1, second);
            const rel = record.slice(second + 1);
            if (!rel) { continue; }
            seen.add(rel);
            // git 对二进制文件报 "-"（行数没意义）：这一行标成看不了
            const binary = addText === "-" || delText === "-";
            const added = Number(addText) || 0;
            const removed = Number(delText) || 0;
            if (!binary && added === 0 && removed === 0) { continue; }   // 只动了权限之类：不算改动
            const info = changeOf(workTree, rel, added, removed, binary);
            if (info) { out.push(info); }
        }
    }
    // 还没被 git 收下的新文件：`git diff` 不认它们（不在 HEAD 里），整份当新增，单独数一遍
    const others = await runGit(workTree, ["ls-files", "-z", "--others", "--exclude-standard"], LIST_TIMEOUT_MS);
    if (others.ok) {
        for (const rel of others.stdout.split("\0")) {
            if (!rel || seen.has(rel)) { continue; }
            const info = newFileOf(workTree, rel);
            if (info) { out.push(info); }
        }
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return { vcs: true, changes: out };
}

/** 一个文件从最近一次提交到现在的 diff（统一格式，界面照现成的画法画）；没差别返回 undefined。 */
export async function changeDiff(workTree: string, relPath: string): Promise<string | undefined> {
    if (!safeRel(relPath)) { return undefined; }
    const r = await runGit(workTree, ["diff", "-U3", "--ignore-cr-at-eol", "--relative", "HEAD", "--", relPath],
        LIST_TIMEOUT_MS);
    if (r.ok && r.stdout.trim()) {
        const body = hunksOnly(r.stdout);
        if (!body) { return undefined; }
        return tooManyDiffLines(body) ? undefined : body;
    }
    // 还没被 git 收下的新文件：`git diff` 不认它，整份当新增（跟清单里那个数对得上）
    const untracked = await runGit(workTree, ["ls-files", "-z", "--others", "--exclude-standard", "--", relPath],
        LIST_TIMEOUT_MS);
    if (!untracked.ok || !untracked.stdout.split("\0").includes(relPath)) { return undefined; }
    const text = readText(workTree, relPath);
    if (text === undefined) { return undefined; }
    const diff = makeUnifiedDiff("", text);
    return diff && !tooManyDiffLines(diff) ? diff : undefined;
}

/**
 * 把这个文件撤到最近一次提交：提交里有它就 checkout 回来（索引与工作区一起），
 * 没有它（会话开始之后才新建、还没提交过）就把它删掉、从索引里也抹掉。
 * @returns undefined = 不归这一套管（会话目录不在仓库里、或者写法越界）
 */
export async function revertToHead(workTree: string, relPath: string):
    Promise<{ ok: boolean; removed: boolean } | undefined> {
    if (!safeRel(relPath) || !(await inGitRepo(workTree))) { return undefined; }
    // 提交里有它就 checkout 回来（索引与工作区一起）；问的是 HEAD 那棵树里有没有这个文件。
    // 这里让 git 自己按会话目录算写法（不自己拼仓库根那一段）：拼错的话下面会把它当新建的删掉，太危险。
    const inHead = await runGit(workTree, ["ls-tree", "-z", "--name-only", "HEAD", "--", relPath], ASK_TIMEOUT_MS);
    if (inHead.ok && inHead.stdout.split("\0").some((one) => one !== "")) {
        const r = await runGit(workTree, ["checkout", "HEAD", "--", relPath], LIST_TIMEOUT_MS);
        return { ok: r.ok, removed: false };
    }
    try {
        fs.rmSync(path.resolve(workTree, relPath), { force: true });
    } catch {
        return { ok: false, removed: true };
    }
    // 进过索引、但一直没提交的那种：留个指向空处的条目，往后每次都得看成「删了」
    await runGit(workTree, ["update-index", "--force-remove", "--", relPath], ASK_TIMEOUT_MS);
    return { ok: true, removed: true };
}

function changeOf(workTree: string, rel: string, added: number, removed: number,
    binary: boolean): SessionChangeInfo | undefined {
    const abs = path.resolve(workTree, rel);
    let deleted = false;
    let tooBig = binary || added + removed > MAX_DIFF_LINES;
    try {
        const st = fs.statSync(abs);
        if (st.isDirectory()) { return undefined; }
        if (st.size > MAX_CHANGE_BYTES) { tooBig = true; }
    } catch {
        deleted = true;   // 文件没了：整份都算删掉（diff 由 git 给）
    }
    return { path: rel, added, removed, deleted, tooBig };
}

/** 最近一次提交里没有的文件：整份当新增，行数跟 diff 都拿现成的那两个函数算。 */
function newFileOf(workTree: string, rel: string): SessionChangeInfo | undefined {
    const abs = path.resolve(workTree, rel);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return undefined; }
    if (!st.isFile()) { return undefined; }
    if (st.size > MAX_CHANGE_BYTES) {
        return { path: rel, added: 0, removed: 0, deleted: false, tooBig: true };
    }
    const text = readText(workTree, rel);
    if (text === undefined) {
        return { path: rel, added: 0, removed: 0, deleted: false, tooBig: true };
    }
    const diff = makeUnifiedDiff("", text);
    if (!diff) { return undefined; }
    const counts = diffCounts(diff);
    return { path: rel, added: counts.added, removed: counts.removed, deleted: false, tooBig: false };
}

/** 读一个文件的文本；读不动、太大、像二进制都给 undefined。 */
function readText(workTree: string, rel: string): string | undefined {
    const abs = path.resolve(workTree, rel);
    try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > MAX_CHANGE_BYTES) { return undefined; }
        const text = fs.readFileSync(abs, "utf8");
        return text.includes("\0") ? undefined : text;
    } catch {
        return undefined;
    }
}
