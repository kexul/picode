/**
 * 独立后端（pichat 服务）用到的几个文件路径。
 *
 * 集中放一个文件是为了能整个目录换掉：设了环境变量 PICHAT_HOME 就用它，
 * 否则用 ~/.pi/pichat。调试时把它指到临时目录，就不会动到用户真正的配置。
 */
import * as os from "os";
import * as path from "path";

/** 后端所有文件所在目录；环境变量 PICHAT_HOME 可以整个换掉（调试用）。 */
export function pichatDir(): string {
    const override = (process.env.PICHAT_HOME ?? "").trim();
    return override || path.join(os.homedir(), ".pi", "pichat");
}

/** 人改的设置文件（pi 路径、默认模型、网页服务端口这些）。 */
export function serverConfigFile(dir: string = pichatDir()): string {
    return path.join(dir, "config.json");
}

/** 程序自己写的显示选项（界面颜色、字号、快捷键这些）。 */
export function serverStateFile(dir: string = pichatDir()): string {
    return path.join(dir, "state.json");
}

/** 正在跑的那个后端的地址文件；单实例判断看它。 */
export function serverAddressFile(dir: string = pichatDir()): string {
    return path.join(dir, "server.json");
}

/** 各会话的「/goal 目标」存这里（键是会话文件路径，见 goalFiles.ts）。 */
export function goalsFile(dir: string = pichatDir()): string {
    return path.join(dir, "goals.json");
}
