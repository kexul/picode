/**
 * 列目录、新建一个子目录：给"选工作目录"那套界面用。
 *
 * 这一层故意不碰 vscode、也不碰网页服务，只认文件系统，于是 VS Code 里、
 * 独立后端里也能直接用同一份逻辑。
 *
 * 出错不往外抛，而是放在返回值的 error 里：对界面来说"这个目录读不到"
 * 和"这个目录是空的"都是正常结果，不该让整个页面崩掉。
 */
import * as fs from "fs";
import * as path from "path";

/** 列出来的一项（只列文件夹，不列文件）。 */
export interface DirEntry {
    /** 目录名（最后一段） */
    name: string;
    /** 绝对路径 */
    path: string;
}

export interface DirListing {
    /** 这次列的是哪个目录（绝对路径；列盘符列表时是空串） */
    path: string;
    /** 上一层目录的绝对路径；已经在最上层（盘符列表 / 根目录）时没有这个字段 */
    parent?: string;
    /** 子目录，按名字排序（不区分大小写） */
    dirs: DirEntry[];
    /** 是不是"最上层"这次列的是盘符 / 根目录 */
    roots: boolean;
    /** 列不动的原因（目录不存在、没权限这类）；能列出来但个别子目录读不到时不算 */
    error?: string;
}

/**
 * 一次最多列这么多子目录：目录里真有几万个子目录时全塞给界面会卡死，
 * 用户也翻不到第 500 个以后；截断了会在 error 里说明。
 */
const MAX_DIRS = 500;

/** 按名字排序，大小写不敏感，让 App 和 app 挨在一起。 */
function compareNames(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** 把底下的异常转成能读的中文句子；拿不到信息时给个兜底的说法。 */
function reasonText(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.trim() || "未知原因";
}

/** Windows 上传空串或者单个斜杠表示"列这台机器上的盘"；别的系统只有空串算。 */
function isRootTarget(target: string): boolean {
    if (target === "") return true;
    return process.platform === "win32" && (target === "/" || target === "\\");
}

/**
 * 列 Windows 上存在的盘：A: 到 Z: 逐个试。
 * 按"能读"来算而不是"存在"：没插盘的软驱、断开的网络盘让用户点进去
 * 也只会看到错误，不如干脆不列出来。
 */
async function listWindowsDrives(): Promise<DirListing> {
    const dirs: DirEntry[] = [];
    for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
        const letter = String.fromCharCode(code);
        const drive = `${letter}:\\`;
        try {
            await fs.promises.access(drive, fs.constants.R_OK);
        } catch {
            continue;
        }
        dirs.push({ name: `${letter}:`, path: drive });
    }
    return { path: "", dirs, roots: true };
}

/** 真去读一个目录的子目录；target 可以不存在、可以是文件，都由这里兜住。 */
async function listChildren(target: string): Promise<DirListing> {
    const resolved = path.resolve(target);
    // 盘根（C:\）和 / 再往上还是自己；到这儿就不给 parent，否则界面会一直在原地打转。
    const atTop = path.dirname(resolved) === resolved;
    const roots = atTop;

    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(resolved);
    } catch (err) {
        return { path: resolved, dirs: [], roots, error: `目录不存在或打不开（${reasonText(err)}）：${resolved}` };
    }
    if (!stats.isDirectory()) {
        return { path: resolved, dirs: [], roots, error: `这不是一个目录：${resolved}` };
    }

    let names: string[];
    try {
        names = await fs.promises.readdir(resolved);
    } catch (err) {
        return { path: resolved, dirs: [], roots, error: `目录不存在或打不开（${reasonText(err)}）：${resolved}` };
    }

    names.sort(compareNames);
    const dirs: DirEntry[] = [];
    let truncated = false;
    for (const name of names) {
        const child = path.join(resolved, name);
        // 用 stat 不用 lstat：软链接指到目录的也要能点进去。
        // 单条 stat 失败就跳过它，别让一条坏链接（或没权限的条目）把整张列表搞挂。
        try {
            if (!(await fs.promises.stat(child)).isDirectory()) continue;
        } catch {
            continue;
        }
        if (dirs.length >= MAX_DIRS) {
            truncated = true;
            break;
        }
        dirs.push({ name, path: child });
    }

    const listing: DirListing = { path: resolved, dirs, roots };
    if (!atTop) listing.parent = path.dirname(resolved);
    if (truncated) listing.error = `子目录太多了，只列出前 ${MAX_DIRS} 个`;
    return listing;
}

/** 新建一个子目录的结果：建好了给它的绝对路径，没建成给一句能读的话。 */
export interface NewDirResult {
    path?: string;
    error?: string;
}

/** 一个名字最多这么长（整条路径的上限另有系统管，这里只挡一眼就知道不对的超长名字）。 */
const MAX_NAME_CHARS = 100;

/**
 * 在一个目录下新建一个子目录（「选择文件夹」那一层里那颗「新建文件夹」）。
 *
 * 名字只认"一层目录名"：空白的、`.` / `..`、带斜杠的（想一次建两层）都不收——
 * 这一颗等于资源管理器里那颗「新建文件夹」，不是 mkdir -p。只建这一层、不递归：
 * 父目录刚才还在、这会儿没了就老实报错，别顺手替人补出一整条路来。
 *
 * 出错不往外抛，跟列目录一个规矩：对界面来说"这个名字用不了"是正常结果，
 * 那句话写在 error 里，界面把它写在浮层标题上。
 */
export async function createSubdirectory(parent: string, rawName: string): Promise<NewDirResult> {
    const name = rawName.trim();
    if (!parent.trim()) { return { error: "得先有一个目录" }; }
    if (!name) { return { error: "名字不能是空的" }; }
    if (name === "." || name === "..") { return { error: "这个名字不能用" }; }
    if (/[\\/]/.test(name)) { return { error: "名字里不能有斜杠" }; }
    if (name.length > MAX_NAME_CHARS) { return { error: `名字太长了（最多 ${MAX_NAME_CHARS} 个字）` }; }

    const target = path.join(parent, name);
    try {
        await fs.promises.mkdir(target);
    } catch (err: any) {
        const code = err && err.code;
        if (code === "EEXIST") { return { error: "这里有同名的了" }; }
        if (code === "EACCES" || code === "EPERM") { return { error: "没有权限在这里建目录" }; }
        if (code === "ENOENT") { return { error: "这个目录已经不在了" }; }
        return { error: `没有建成（${reasonText(err)}）` };
    }
    return { path: target };
}

/** 列出某个目录下的子目录；target 传空串表示列这台机器的根（Windows 是各个盘，其它系统是 /）。 */
export function listDirectories(target: string): Promise<DirListing> {
    if (isRootTarget(target)) {
        if (process.platform === "win32") return listWindowsDrives();
        // 非 Windows 的最上层就是 /；走普通那条路，根目录判断会自己把 roots 置真
        return listChildren("/");
    }
    return listChildren(target);
}
