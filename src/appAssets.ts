/**
 * appAssets —— 界面文件（media/）与两支小程序（bin/tray.exe、bin/shot.exe）在哪儿。
 *
 * 两种跑法，路径的算法其实一样（都是“这个文件往上两层”）：
 *   1. 仓库里 / 全局装的那份包：`out/server/*.js` → 往上两层就是仓库根，下面有 media/ 与 bin/。
 *   2. 单文件 exe：壳（bin/launcher.cs）把 bundle 解到
 *      `<缓存>/app-<版本>/out/server/bundle.cjs`，资源按同样的结构摊在旁边 —— 所以往上两层
 *      还是“有 media/ 与 bin/ 的那一层”。
 *
 * 所以这里只需要认“是不是那个 exe 起的”（壳会设一个环境变量），用来决定一些说法与做法：
 * 日志写哪儿、设置面板里那行怎么描述、能不能重新打包。
 */
import * as fs from "fs";
import * as path from "path";

/** 这个后端是不是被那个单文件 exe（壳）起的。壳会把自己的路径放进 PICHAT_LAUNCHER。 */
export function isPackaged(): boolean {
    return typeof process.env.PICHAT_LAUNCHER === "string" && process.env.PICHAT_LAUNCHER.length > 0;
}

/** 那个 exe 的完整路径（不是从 exe 起的就没有）。 */
export function launcherPath(): string | undefined {
    const value = process.env.PICHAT_LAUNCHER;
    return value && value.length > 0 ? value : undefined;
}

let cachedRoot: string | undefined;

/** 界面文件与小程序所在的那个目录（它下面有 media/ 与 bin/）。 */
export function appRoot(): string {
    if (cachedRoot) { return cachedRoot; }
    cachedRoot = path.join(__dirname, "..", "..");
    return cachedRoot;
}

/** 界面文件目录（网页服务按路径读这里的文件）。 */
export function mediaDir(): string {
    return path.join(appRoot(), "media");
}

/** 两支小程序里某一支的完整路径（`shot.exe` / `tray.exe`）。 */
export function appBin(name: string): string {
    return path.join(appRoot(), "bin", name);
}

/** 版本号：读这一层下面的 package.json（壳解包时也会写一份进去）。 */
export function appVersion(): string {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(appRoot(), "package.json"), "utf8"));
        return typeof parsed.version === "string" ? parsed.version : "0";
    } catch {
        return "0";
    }
}
