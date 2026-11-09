/**
 * imageFit —— 发给页面的图先缩一缩（Windows；别的系统上照原样发）。
 *
 * 为什么要它：会话里的工具结果图（截图居多）是按原尺寸整张 base64 发过去的。一张
 * 2560×1440 的 PNG 两三 MB，base64 还要再涨三分之一 —— 手机上打开会话、或者模型边跑
 * 边读图，这一笔一笔地下来，等得人心焦。而这些图在界面上显示出来也就几百像素宽。
 *
 * 做法：先交给 `bin/cwebp.exe`（libwebp 官方 Windows 构建里的那个命令）—— 解码、缩放、编 WebP
 * 它一次做完，长边 1280 以内、质量 75。实测一张 2.76 MB 的 PNG 截图变成 66 KB（同一张走 JPEG
 * 是 194 KB），图里的小字仍旧看得清；带透明的图它也能留透明。
 *
 * 拿不到 `cwebp.exe`（非 Windows、被杀软拦下）时退回 `bin/resize.exe` 那支（GDI+，同样的长边与质量、
 * 编成 JPEG，见 bin/resize.cs）；两支都没有就照原样发。
 *
 * 几条要点：
 *   - **只管“发给页面”的那一份，不碰发给模型的**：pi 请求里用的还是会话里 / 磁盘上的原图
 *     （PNG 就还是 PNG，见 src/imageOffloadBridgeSource.ts）；这里换掉的只是一份显示用的副本，
 *     编完不落盘（临时目录用完就删），会话文件与那几张原图一个字节没动。
 *   - **只缩“要真发过去”的图**（首屏里点名带上、或者当场跑完推给页面的那些）。界面上点开
 *     再看的那张（`点开看这张图`）照旧给原图：那是人明确要看细节。
 *   - 已经被 pi 的扩展挪出会话文件、只有路径的图，缩完不落盘（下次再读原图再缩一次）；
 *     反正只在“这一屏要带上”的时候才走这一步。
 *   - 缩出来不比原来的小（本来就是小图、或者本来已是压得很紧的 JPEG）就不换。
 *   - 没有这支小程序（非 Windows、没编出来、被杀软拦下）时返回 undefined，调用方照原样发。
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appBin } from "./appAssets";
import type { ResultImageBlock } from "./messageUtils";

/** 长边缩到这个像素以内：界面上图片也就几百像素宽，手机上更窄；1280 是“
 *  点开放大还能认出字”与“再省四成”之间的折中（实测同一张 2.76 MB 截图：1600/q80 是 113 KB，
 *  1280/q75 是 66 KB）。 */
const MAX_EDGE = 1280;

/** 质量。75 在截图上是“小字还认得出”的那一档。 */
const QUALITY = 75;

/** 比这还小（base64 字符数）就不折腾了：省不下几个字节，白起一次进程。 */
const MIN_B64_CHARS = 200 * 1024;

/** 起一次到出图的上限。正常一两百毫秒，大图慢一些；到点进程会被杀掉（照原样发）。 */
const TIMEOUT_MS = 20000;

/** 缩影结果的缓存上限（按图片内容认）。重放同一条会话时不用再缩一遍。 */
const CACHE_MAX = 64;

const cache = new Map<string, { data: string; mimeType: string } | null>();
/** cwebp 在不在：问一次就记住（不在就不再试着起它，直接走下面 JPEG 那支）。 */
let webpUsable: boolean | undefined;

/** WebP 编码命令（随仓库带着，见 bin/cwebp.exe 与 THIRD-PARTY-NOTICES.md）。 */
const CWEBP_EXE = (): string => appBin("cwebp.exe");

/** 缩图小程序（构建时编好的那支，见 bin/resize.cs 与 scripts/compile.mjs）：cwebp 用不了时靠它。 */
const RESIZE_EXE = (): string => appBin("resize.exe");

/**
 * 一张图缩一缩。
 * @param data 原图 base64
 * @returns 缩好的图；不值得缩 / 缩不了时 undefined（调用方照原样发）
 */
export function fitImage(data: string, mimeType: string): { data: string; mimeType: string } | undefined {
    if (typeof data !== "string" || data.length < MIN_B64_CHARS) { return undefined; }
    if (mimeType === "image/gif" || mimeType === "image/svg+xml") { return undefined; }   // 动图与矢量图不缩
    const key = crypto.createHash("sha1").update(data).digest("hex");
    if (cache.has(key)) { return cache.get(key) ?? undefined; }
    const out = shrink(data);
    const result = out && out.data.length < data.length ? out : null;
    if (cache.size >= CACHE_MAX) { cache.clear(); }
    cache.set(key, result);
    return result ?? undefined;
}

/** 缩一张：先 WebP，不行退 JPEG，都不行返回 undefined（调用方照原样发）。 */
function shrink(data: string): { data: string; mimeType: string } | undefined {
    if (process.platform !== "win32") { return undefined; }
    return shrinkToWebp(data) ?? shrinkToJpeg(data);
}

/**
 * 走 cwebp：解码、缩放、编 WebP 它一次做完。
 *
 * cwebp 只认文件（标准输入它不认），所以原图先落到一个临时目录里，编完读回来、整个目录删掉。
 * 只有第一次碰到某张图才会走到这里（结果按内容哈希缓存着）。
 */
function shrinkToWebp(data: string): { data: string; mimeType: string } | undefined {
    const exe = CWEBP_EXE();
    if (webpUsable === undefined) { webpUsable = fs.existsSync(exe); }
    if (!webpUsable) { return undefined; }
    let dir = "";
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-img-"));
        const input = path.join(dir, "in");
        const output = path.join(dir, "out.webp");
        fs.writeFileSync(input, Buffer.from(data, "base64"));
        execFileSync(exe, [
            "-quiet", "-q", String(QUALITY), "-m", "4",
            // down_only：只缩不放（原图比上限小的时候别把它吹大）
            "-resize", String(MAX_EDGE), "0", "-resize_mode", "down_only",
            input, "-o", output,
        ], { timeout: TIMEOUT_MS, windowsHide: true, stdio: "ignore" });
        const out = fs.readFileSync(output).toString("base64");
        return out ? { data: out, mimeType: "image/webp" } : undefined;
    } catch {
        return undefined;   // 图坏了 / 编码失败：退 JPEG
    } finally {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } }
    }
}

/** 退路：GDI+ 那支小程序，缩到同样长边、编 JPEG。 */
function shrinkToJpeg(data: string): { data: string; mimeType: string } | undefined {
    const exe = RESIZE_EXE();
    if (!fs.existsSync(exe)) { return undefined; }
    try {
        const stdout = execFileSync(exe, [String(MAX_EDGE), String(QUALITY)], {
            input: data,
            timeout: TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
        });
        const text = stdout.toString("utf8").trim();
        return text ? { data: text, mimeType: "image/jpeg" } : undefined;
    } catch {
        // 图损坏、编解码器缺失、进程被杀：这一张照原样发，下次还会再试
        return undefined;
    }
}

/**
 * 一批工具结果图里，把“要真发过去”的那些（有数据的）缩一缩。
 * 只有路径的、以及本来就很小的，原样留在数组里。
 */
export function fitResultImages(images: ResultImageBlock[]): ResultImageBlock[] {
    if (images.length === 0) { return images; }
    let changed = false;
    const out = images.map((img) => {
        if (!img.data) { return img; }
        const fitted = fitImage(img.data, img.mimeType);
        if (!fitted) { return img; }
        changed = true;
        return { ...img, data: fitted.data, mimeType: fitted.mimeType, bytes: Math.round((fitted.data.length * 3) / 4) };
    });
    return changed ? out : images;
}
