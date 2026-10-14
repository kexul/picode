/**
 * 路径与目录的公共规矩：归一化、判相等、判包含、算相对写法。
 *
 * 这几件事以前散在各处各写一遍（会话编排、宿主、屏幕登记簿、插件那两处……），规则还不完全
 * 一样：有的按平台分大小写，有的偏偏一律转小写，于是 Linux / macOS 上 /home/A 和 /home/a
 * 会被当成同一个目录。合成一处之后只有这一套规矩：**按平台分大小写（Windows 那边不分）**。
 *
 * “同一个目录”只看路径字符串：不解析软链接、不看 inode。
 */
import * as path from "path";

/**
 * 归一化成一个可以当键用的写法：解析成绝对路径、斜杠统一成正斜杠、去掉末尾多余的斜杠，
 * Windows 上再转小写。空串原样返回（调用方按“没这个目录”处理）。
 */
export function dirKey(p: string): string {
    if (!p) { return ""; }
    const s = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
}

/** 两个目录是不是同一个。 */
export function sameDir(a: string, b: string): boolean {
    const key = dirKey(a);
    return !!key && key === dirKey(b);
}

/** 这个目录在不在那个目录里（相等也算）。 */
function dirInside(dir: string, folder: string): boolean {
    const target = dirKey(dir);
    const base = dirKey(folder);
    if (!target || !base) { return false; }
    // 相等是必须的（窗口就打开在这个目录上）
    if (target === base) { return true; }
    // 落在里面也算，是为了兜住“窗口打开的是上级目录”这种情况
    // （比如工作区开在 D:\projects，会话在 D:\projects\picode）。
    // 用 path 的关系判断，别用字符串前缀：D:\projects2 不能被 D:\projects 认领。
    const rel = path.posix.relative(base, target);
    return rel !== "" && !rel.startsWith("..") && !path.posix.isAbsolute(rel);
}

/** 这个目录在不在那几个目录里（任何一个算）。 */
export function dirInsideAny(dir: string, folders: readonly string[]): boolean {
    return folders.some((folder) => dirInside(dir, folder));
}

/**
 * 一个绝对路径相对某个目录的写法（不在里面就原样返回）。
 *
 * 返回的是给界面看的：正斜杠、大小写照原样，所以这里按原始字符串切，
 * 不用 dirKey 那份归一化结果（它已经解析过、转过小写，长度都可能对不上）。
 */
export function relativeTo(cwd: string, full: string): string {
    if (!cwd || !full) { return full; }
    const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    const f = full.replace(/\\/g, "/");
    const hit = process.platform === "win32"
        ? f.toLowerCase().startsWith(c.toLowerCase())
        : f.startsWith(c);
    return hit ? f.slice(c.length) : full;
}
