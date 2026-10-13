import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * mediaVersion —— 界面文件（media/ 里那几个 js）的"内容指纹"。
 *
 * 为什么需要它：手机上刷新一次页面，浏览器本来可以什么都不用重下，
 * 但界面文件以前发的是 no-store（不许缓存），于是 chat.js 那 233KB 每次都得重来一遍
 * （实测手机网速下要 1.7 秒，界面要等到它下完才开始干活）。改成"地址里带指纹 + 长期缓存"：
 *   - 文件没变 → 地址没变 → 浏览器直接用自己存的那份，一次请求都不发；
 *   - 文件改了（改代码 / 升级插件）→ 指纹变了 → 地址变了 → 浏览器拿新的那份，不会看到旧的。
 *
 * 指纹按"文件修改时间 + 大小"缓存：每次问只 stat 一下，内容变了才重新读文件算一遍。
 * （网页服务是长跑的进程，不缓存的话每次请求都要把 233KB 读进来哈希一遍。）
 */

/** 路径 → 上次算指纹时的"修改时间 + 大小"与算出来的指纹。 */
const cache = new Map<string, { stamp: string; version: string }>();

/** 文件的"改了没有"标记（修改时间 + 大小）；文件读不到时回空串。 */
function stampOf(file: string): string {
    try {
        const st = fs.statSync(file);
        return `${st.mtimeMs}:${st.size}`;
    } catch {
        return "";
    }
}

/**
 * 取一个界面文件的"改了没有"标记（修改时间 + 大小）。
 * 网页服务拿它当 gzip 结果的缓存键：内容没变就不用重压一遍。
 */
export function mediaStamp(mediaDir: string, name: string): string {
    return stampOf(path.join(mediaDir, name));
}

/**
 * 取一个界面文件的内容指纹（短串，直接拼在 /media/xxx?v= 后面）。
 * 文件读不到时返回空串：调用方按"没有指纹"处理（退回不缓存那一档）。
 */
export function mediaVersion(mediaDir: string, name: string): string {
    const file = path.join(mediaDir, name);
    const stamp = stampOf(file);
    if (!stamp) {
        return "";
    }
    const hit = cache.get(file);
    if (hit && hit.stamp === stamp) {
        return hit.version;
    }
    let version = "";
    try {
        const data = fs.readFileSync(file);
        version = crypto.createHash("sha1").update(data).digest("hex").slice(0, 10);
    } catch {
        return "";
    }
    cache.set(file, { stamp, version });
    return version;
}
