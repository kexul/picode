/**
 * 会话开始给工作区拍一次快照，之后「改动」那一格就拿它跟现在比。
 *
 * 为什么非得有这么一份快照：下格要回答「这个会话改了哪些文件、各改了多少行」，而 bash 里跑的
 * 任意程序（`sed -i`、脚本、构建命令）改了哪个文件、改之前长什么样，插件事前都不知道。
 * 能说清这件事的只有「会话开始那一刻的内容」，所以借 git 来做（它本来就擅长存这个）：
 *
 *   - 仓库放在用户目录下（影子仓库），项目目录里一个字节都不多出来，也不动项目自己的 .git；
 *     仓库根就是会话目录时，用 alternates 直接引用它的对象库：已经提交过的内容只引用不复制，
 *     快照几乎不占磁盘；会话目录只是大仓库里的一层时按普通目录处理（不去碰上一层的东西）。
 *   - 不是仓库时只能自己存一份，所以先估个大小，太大就不拍（那一格退回只看 edit / write，
 *     见 EditTracker），免得一个巨大的目录把盘和内存吃掉。
 *   - 「哪些文件算数」分两条路：
 *       · 会话目录本身就是 git 仓库的根：跟 git 走（工作区里 `git` 认为变了的都算，
 *         `.gitignore` 忽略的除外），不另筛类型 —— 这儿的仓库只是借它的对象库，不多存东西；
 *       · 不是仓库（要真存一份）：只收代码那一类（白名单见下面 CODE_EXTS），
 *         日志、会话记录（`.jsonl`）、纯文本转储、补丁、图片、超过 2 MB 的都不进 ——
 *         它们是成本大头，也画不出 diff。名单之外的东西仍然由 edit / write 那套管。
 *
 * 口径统一是「会话开始 → 现在」：清单里的行数和点开的 diff 都从这一份快照算出来，不会打架。
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { diffCounts, makeUnifiedDiff } from "./messageUtils";
import { pichatDir } from "./serverPaths";

/** 一个文件的合计改动（跟 EditTracker 的 SessionChangeInfo 同一个长相，界面那边不用分家）。 */
export interface SnapshotChange {
    /** 相对会话目录的写法（跟文件链接里的写法一样）。 */
    path: string;
    added: number;
    removed: number;
    /** 文件已经不在了（删掉了）。 */
    deleted: boolean;
    /** 不比了：二进制、太大、或者改动行数太多，界面那一行点不开。 */
    tooBig: boolean;
}

/** 单个文件愿意比的文本上限：超过它的既不进快照，也不算行数（本来也画不出 diff）。 */
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;
/** 一份 diff 的行数上限：再多就不往页面上拖了（那一行标成「看不了」）。 */
const MAX_DIFF_LINES = 20_000;
/** 拍快照时最多认多少个文件：超了就不拍（不是仓库的大目录常在这一步被挡下）。 */
const MAX_SNAPSHOT_FILES = 20_000;
/** 拍快照时最多认多少字节：超了就不拍。 */
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
/** 影子仓库最多留多少个（超了删最老的）：会话正常关掉会自己删，留下的都是异常退出那种。 */
const SHADOW_MAX_DIRS = 32;
/** 影子仓库搁多久算「没人要了」（毫秒）：异常退出留下的，过了这个时间下次启动顺手删掉。 */
const SHADOW_TTL_MS = 12 * 60 * 60 * 1000;
const INIT_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 60_000;
const DIFF_TIMEOUT_MS = 20_000;

/**
 * 白名单：会话目录不是仓库时，只收这几类（「代码 ＋ 配置 ＋ 文档」）。要加就往这儿加。
 * 为什么只在“不是仓库”时用：那种目录要真存一份内容，而里面真正肥的是日志、会话记录
 * （`.jsonl`）、纯文本转储、补丁、图片这些（实测一个调试目录里 100 MB 有 90 MB 是它们，
 * 代码才几 MB）；是仓库时对象库都是现成的，不必筛，跟 git 走就行。
 * 代价：名单外的东西（`bash` 改的）看不见——所以这个名单要跟着语言 / 项目长。
 * 不收 `.txt`：实际项目里的纯文本转储、日志落盘多数是这个后缀，代价大于收益。
 */
const CODE_EXTS = [
    // 前端 / 脚本
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
    "css", "scss", "sass", "less", "styl", "html", "htm", "md", "mdx", "rst", "adoc",
    // 配置 / 数据
    "json", "jsonc", "json5", "yml", "yaml", "toml", "ini", "cfg", "conf", "properties",
    "xml", "plist", "env", "sql", "graphql", "gql", "proto", "thrift", "csv",
    // 后端 / 系统
    "py", "pyi", "rb", "php", "pl", "pm", "lua", "go", "rs", "java", "kt", "kts",
    "scala", "groovy", "gradle", "cs", "csproj", "sln", "fs", "fsx", "vb", "swift",
    "m", "mm", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cu", "cuh",
    "asm", "s", "dart", "ex", "exs", "erl", "hrl", "hs", "lhs", "clj", "cljs", "elm",
    "jl", "r", "zig", "v", "nim", "sol", "move",
    // 构建 / 基础设施 / 命令
    "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "awk", "sed", "el", "vim",
    "cmake", "mk", "tf", "tfvars", "hcl", "nix", "tex", "bib",
];

/** 没有扩展名、但名字固定的那几个（Makefile、LICENSE 这些也算文档 / 配置）。 */
const CODE_NAMES = [
    "Makefile", "makefile", "Dockerfile", "Containerfile", "Justfile",
    "LICENSE", "COPYING", "NOTICE", "README", ".env*",
    ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc",
];

/**
 * 不管名单怎么说都跳过的目录（依赖、版本库、编辑器缓存）：不跳的话 git 会往里翻几十万个文件。
 * 产物目录（dist / build / out / bin / lib / vendor / target）故意不放：很多项目里它们是源码目录，
 * 该不该排除让项目自己的 .gitignore 说，比我们猜准。
 */
const SKIP_DIRS = [".git/", "node_modules/", "__pycache__/", ".venv/", "venv/", ".idea/", ".DS_Store"];

/** 每次调 git 都带上的配置：别按平台改行尾、路径别转义成八进制、别自动打包。 */
const GIT_FLAGS = [
    "-c", "core.autocrlf=false",
    "-c", "core.safecrlf=false",
    "-c", "core.quotepath=false",
    "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0",
];

/** 跑一条 git 命令；失败不抛，返回 ok=false（调用方按「这次算不出来」处理）。 */
function runGit(args: string[], opts: { cwd?: string; gitDir?: string; workTree?: string; timeoutMs: number }):
    Promise<{ ok: boolean; stdout: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (opts.gitDir) { env.GIT_DIR = opts.gitDir; }
    if (opts.workTree) { env.GIT_WORK_TREE = opts.workTree; }
    return new Promise((resolve) => {
        execFile("git", [...GIT_FLAGS, ...args], {
            cwd: opts.cwd,
            env,
            windowsHide: true,
            timeout: opts.timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
            encoding: "utf8",
        }, (err, stdout) => resolve({ ok: !err, stdout: typeof stdout === "string" ? stdout : "" }));
    });
}

/** 影子仓库都放在这儿（跟着 PICHAT_HOME 走：调试时指到临时目录就不会动到真的）。 */
function shadowRoot(): string {
    return path.join(pichatDir(), "shadow");
}

/** 一个会话一个子目录；名字里带进程号，另一个进程（比如插件和独立后端同时开着）也撞不上。 */
function shadowDirFor(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "session";
    return path.join(shadowRoot(), `${safe}-${process.pid}`);
}

function removeDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就算了：下次启动还会再试 */ }
}

/** 进程里只清一次：异常退出留下的影子仓库，过期的、以及多出来的，都在这儿收掉。 */
let pruned = false;
function pruneOldShadowDirs(): void {
    if (pruned) { return; }
    pruned = true;
    const root = shadowRoot();
    let names: string[];
    try { names = fs.readdirSync(root); } catch { return; }
    const now = Date.now();
    const alive: Array<{ full: string; mtime: number }> = [];
    for (const name of names) {
        const full = path.join(root, name);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (!st.isDirectory()) { continue; }
        if (now - st.mtimeMs > SHADOW_TTL_MS) { removeDir(full); continue; }
        alive.push({ full, mtime: st.mtimeMs });
    }
    alive.sort((a, b) => a.mtime - b.mtime);
    for (const old of alive.slice(0, Math.max(0, alive.length - SHADOW_MAX_DIRS))) { removeDir(old.full); }
}

/** 两个路径是不是同一个（大小写、结尾斜杠这些不较真）。 */
function samePath(a: string, b: string): boolean {
    const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    return norm(a) === norm(b);
}

/**
 * 后端自己那些文件（设置、地址、以及这儿的影子仓库）要是正好落在会话目录里，得排除掉：
 * 不然快照会一边往里面写一边把它当工作区的内容收进来（调试用的 dev/.scratch 就是这种）。
 * 不在会话目录里（正常情况）返回 undefined。
 */
function ownFilesExclude(workTree: string): string | undefined {
    const rel = path.relative(workTree, pichatDir());
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { return undefined; }
    return `${rel.split(path.sep).join("/")}/`;
}

/**
 * 会话目录本身是 git 仓库的根时，返回它对象库的绝对路径（影子仓库拿 alternates 引用它，
 * 已经提交过的内容就不用复制一份）；不是仓库、或者只是大仓库里的一层，返回 undefined。
 */
async function repoObjectsOf(workTree: string): Promise<string | undefined> {
    const r = await runGit(["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: workTree, timeoutMs: 10_000 });
    if (!r.ok) { return undefined; }
    const lines = r.stdout.trim().split(/\r?\n/);
    if (lines.length < 2 || !lines[0] || !lines[1]) { return undefined; }
    if (!samePath(path.resolve(workTree, lines[0]), workTree)) { return undefined; }
    const objects = path.join(path.resolve(workTree, lines[1]), "objects");
    try {
        if (!fs.statSync(objects).isDirectory()) { return undefined; }
    } catch {
        return undefined;
    }
    return objects;
}

/**
 * 拍快照前先问 git：这棵目录里都有哪些文件（.gitignore 和 info/exclude 当场生效），
 * 顺便把「单个太大的文件」写进排除名单 —— 二进制资产那种不该为了它把整份快照都放弃，
 * 只是它自己不进清单（那几个文件仍然由 edit / write 那套管）。
 * @param limit 要不要卡总大小 / 总文件数（不是仓库时卡：那份内容要真存一份；已经有仓库对象可借时不卡）
 * @returns 能不能拍（false = 超过上限，直接放弃）
 */
async function prepareSnapshot(gitDir: string, workTree: string, limit: boolean): Promise<boolean> {
    const list = await runGit(["ls-files", "-z", "--others", "--exclude-standard"], {
        gitDir, workTree, timeoutMs: 30_000,
    });
    if (!list.ok) { return false; }
    const files = list.stdout.split("\0").filter((one) => one !== "");
    if (limit && files.length > MAX_SNAPSHOT_FILES) { return false; }
    let total = 0;
    const oversized: string[] = [];
    for (const rel of files) {
        let st: fs.Stats;
        try { st = fs.statSync(path.resolve(workTree, rel)); } catch { continue; }
        if (!st.isFile()) { continue; }
        if (st.size > MAX_CHANGE_BYTES) { oversized.push(rel); continue; }
        total += st.size;
        if (limit && total > MAX_SNAPSHOT_BYTES) { return false; }
    }
    if (oversized.length > 0) {
        // 以 / 开头 = 相对会话目录根，免得这几行在哪里都套上
        fs.appendFileSync(path.join(gitDir, "info", "exclude"),
            oversized.map((rel) => `/${rel}`).join("\n") + "\n", "utf8");
    }
    return true;
}

/**
 * 影子仓库的排除名单。
 *
 * 不是仓库（要真存一份内容）：先用 `*` 把一切都排除，再把白名单那几类逐个放回来。
 * 不这么写就没法“只收白名单”：gitignore 没有“只收”这种写法，只能先全关再一个个开
 * （放行目录的那一行是让 git 还肯往目录里走，不然它连看都不看就整棵树跳过）。
 *
 * 是仓库（只借它的对象库）：不筛类型，跟 git 自己 `.gitignore` 的那套走 ——
 * 那时候“改了什么”应该由仓库说了算，不该我们另订一套。
 * @param workTree 会话目录（后端自己的文件正好落在里面时要多跳一条，见 ownFilesExclude）
 * @param whitelist 要不要只收白名单里那几类
 */
function excludeText(workTree: string, whitelist: boolean): string {
    const lines = [
        "# 这个目录是自动建的临时快照仓库，可以随时整个删掉。",
        whitelist
            ? "# 只收代码 / 配置 / 文档那几类（名单见 src/changeSnapshot.ts）；日志、会话记录、"
                + "纯文本转储、补丁、图片这些不进快照 —— 它们是成本大头，也画不出 diff。"
            : "# 跟 git 自己的 .gitignore 走，这里只补几条依赖 / 缓存目录。",
        ...(whitelist ? ["*", "!*/"] : []),
        ...SKIP_DIRS,
    ];
    const own = ownFilesExclude(workTree);
    if (own) { lines.push(own); }
    if (!whitelist) {
        lines.push("");
        return lines.join("\n");
    }
    for (const ext of CODE_EXTS) { lines.push(`!*.${ext}`); }
    for (const name of CODE_NAMES) { lines.push(`!${name}`); }
    lines.push("");
    return lines.join("\n");
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
 * 会话开始那一刻的工作区快照。用不动就返回 undefined（不是仓库又没有 git、太大、git 出错），
 * 调用方按「这一格只有 edit / write 那套」处理。
 */
export class ChangeSnapshot {
    private constructor(
        private readonly gitDir: string,
        private readonly workTree: string,
        private readonly baseTree: string,
    ) {}

    /**
     * 拍一份快照（建影子仓库 + 把现在的工作区记进一棵树对象）。慢、异步，别挡着会话起来。
     * @param sessionId 哪个会话（影子仓库目录按它分）
     * @param workTree 会话目录（工作区）
     */
    public static async open(opts: { sessionId: string; workTree: string }): Promise<ChangeSnapshot | undefined> {
        pruneOldShadowDirs();
        const workTree = opts.workTree;
        const gitDir = shadowDirFor(opts.sessionId);
        try {
            const objects = await repoObjectsOf(workTree);
            removeDir(gitDir);
            fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
            const init = await runGit(["init", "--quiet", "--bare", gitDir], { timeoutMs: INIT_TIMEOUT_MS });
            if (!init.ok) { removeDir(gitDir); return undefined; }
            fs.writeFileSync(path.join(gitDir, "info", "exclude"), excludeText(workTree, !objects), "utf8");
            if (objects) {
                fs.mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
                fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${objects}\n`, "utf8");
            }
            // 不是仓库时这份内容要真存一份，所以卡总大小；有仓库对象可借时不必卡
            if (!(await prepareSnapshot(gitDir, workTree, !objects))) {
                removeDir(gitDir);
                return undefined;
            }
            const add = await runGit(["add", "-A"], { gitDir, workTree, timeoutMs: SNAPSHOT_TIMEOUT_MS });
            if (!add.ok) { removeDir(gitDir); return undefined; }
            const tree = await runGit(["write-tree"], { gitDir, workTree, timeoutMs: INIT_TIMEOUT_MS });
            const baseTree = tree.stdout.trim();
            if (!tree.ok || !/^[0-9a-f]{40,64}$/.test(baseTree)) { removeDir(gitDir); return undefined; }
            return new ChangeSnapshot(gitDir, workTree, baseTree);
        } catch {
            removeDir(gitDir);
            return undefined;
        }
    }

    /** 这个会话改过的文件清单（快照 → 现在的磁盘），按路径排。 */
    public async changes(): Promise<SnapshotChange[]> {
        const out: SnapshotChange[] = [];
        const seen = new Set<string>();
        // --ignore-cr-at-eol：整份行尾从 LF 变成 CRLF（Windows 上仓库按 CRLF 检出、编辑工具按 LF
        // 写回去，很常见）不算改动。不加这个，内容一个字没改的文件会报成整份重写（+2033 −2034）。
        const numstat = await runGit(["diff", "--numstat", "--no-renames", "--ignore-cr-at-eol", "-z", this.baseTree], {
            gitDir: this.gitDir, workTree: this.workTree, timeoutMs: DIFF_TIMEOUT_MS,
        });
        if (!numstat.ok) { return []; }
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
            const info = this.changeOf(rel, added, removed, binary);
            if (info) { out.push(info); }
        }
        // 快照之后才出现的文件：不在快照树里，git diff 看不见，单独数一遍
        const others = await runGit(["ls-files", "-z", "--others", "--exclude-standard"], {
            gitDir: this.gitDir, workTree: this.workTree, timeoutMs: DIFF_TIMEOUT_MS,
        });
        if (others.ok) {
            for (const rel of others.stdout.split("\0")) {
                if (!rel || seen.has(rel)) { continue; }
                const info = this.newFileOf(rel);
                if (info) { out.push(info); }
            }
        }
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    /** 一个文件从快照到现在的 diff（统一格式，界面照现成的画法画）；没差别返回 undefined。 */
    public async diff(relPath: string): Promise<string | undefined> {
        const r = await runGit(["diff", "-U3", "--ignore-cr-at-eol", this.baseTree, "--", relPath], {
            gitDir: this.gitDir, workTree: this.workTree, timeoutMs: DIFF_TIMEOUT_MS,
        });
        if (r.ok && r.stdout.trim()) {
            const body = hunksOnly(r.stdout);
            if (!body) { return undefined; }
            return tooManyDiffLines(body) ? undefined : body;
        }
        // 快照之后才出现的文件：git diff 不认它，整份当新增（跟清单里那个数对得上）
        const untracked = await runGit(["ls-files", "-z", "--others", "--exclude-standard", "--", relPath], {
            gitDir: this.gitDir, workTree: this.workTree, timeoutMs: DIFF_TIMEOUT_MS,
        });
        if (!untracked.ok || !untracked.stdout.includes(relPath)) { return undefined; }
        const text = this.readText(relPath);
        if (text === undefined) { return undefined; }
        const diff = makeUnifiedDiff("", text);
        return diff && !tooManyDiffLines(diff) ? diff : undefined;
    }

    /**
     * 会话开始那一刻这个文件长什么样（「改动」里点开一份 diff、按那颗「回滚」时用：
     * 就是把这份 diff 左边那一份写回磁盘）。
     *
     * @returns existed=false 表示那时还没有这个文件（回滚就是把它删掉）；
     *          快照里说不清（git 出错）、或者读出来是二进制（没法往回写）给 undefined。
     */
    public async baseFile(relPath: string): Promise<{ existed: boolean; text?: string } | undefined> {
        const listed = await runGit(["ls-tree", "-z", "--name-only", this.baseTree, "--", relPath], {
            gitDir: this.gitDir, workTree: this.workTree, timeoutMs: DIFF_TIMEOUT_MS,
        });
        if (!listed.ok) { return undefined; }
        if (!listed.stdout.split("\0").includes(relPath)) { return { existed: false }; }
        const blob = await runGit(["cat-file", "blob", `${this.baseTree}:${relPath}`], {
            gitDir: this.gitDir, workTree: this.workTree, timeoutMs: DIFF_TIMEOUT_MS,
        });
        if (!blob.ok) { return undefined; }
        if (blob.stdout.includes("\0")) { return undefined; }   // 二进制：写回去只会把那文件弄坏
        return { existed: true, text: blob.stdout };
    }

    /** 会话关掉时叫它：影子仓库整个删掉（异常退出留下的那份由 pruneOldShadowDirs 收）。 */
    public dispose(): void {
        removeDir(this.gitDir);
    }

    private changeOf(rel: string, added: number, removed: number, binary: boolean): SnapshotChange | undefined {
        const abs = path.resolve(this.workTree, rel);
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

    /** 快照之后新出现的文件：整份当新增，行数跟 diff 都拿现成的那两个函数算。 */
    private newFileOf(rel: string): SnapshotChange | undefined {
        const abs = path.resolve(this.workTree, rel);
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { return undefined; }
        if (!st.isFile()) { return undefined; }
        if (st.size > MAX_CHANGE_BYTES) {
            return { path: rel, added: 0, removed: 0, deleted: false, tooBig: true };
        }
        const text = this.readText(rel);
        if (text === undefined) {
            return { path: rel, added: 0, removed: 0, deleted: false, tooBig: true };
        }
        const diff = makeUnifiedDiff("", text);
        if (!diff) { return undefined; }
        const counts = diffCounts(diff);
        return { path: rel, added: counts.added, removed: counts.removed, deleted: false, tooBig: false };
    }

    /** 读一个文件的文本；读不动、太大、像二进制都给 undefined。 */
    private readText(rel: string): string | undefined {
        const abs = path.resolve(this.workTree, rel);
        try {
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > MAX_CHANGE_BYTES) { return undefined; }
            const text = fs.readFileSync(abs, "utf8");
            return text.includes("\0") ? undefined : text;
        } catch {
            return undefined;
        }
    }
}
