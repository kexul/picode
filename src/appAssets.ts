/**
 * appAssets —— 界面文件（media/）与两支小程序（bin/shot.exe、bin/live.exe）在哪儿。
 *
 * 就一种跑法：仓库里 / 全局装的那份包，`out/server/*.js` 往上两层就是有 media/ 与 bin/ 的那一层。
 */
import * as fs from "fs";
import * as path from "path";

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

/** 两支小程序里某一支的完整路径（`shot.exe` / `live.exe`）。 */
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
