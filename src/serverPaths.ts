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

/** 各会话的「自动接着干（/auto）开关」存这里（键是会话文件路径，见 autoFiles.ts）。 */
export function autoFile(dir: string = pichatDir()): string {
    return path.join(dir, "auto.json");
}

/**
 * 微信那头（ClawBot）的登录态：拿到的令牌、绑的是哪个机器人、以后发消息该往哪个地址发。
 * 这里面是凭据（拿到就等于能拿这个号发消息），POSIX 上只给自己读（见 weixinLogin.ts 存盘那段）。
 */
export function weixinAccountFile(dir: string = pichatDir()): string {
    return path.join(dir, "weixin", "account.json");
}

/** 微信那头收到的消息读到哪儿了（重启后接着读，不把老消息再办一遍）。 */
export function weixinCursorFile(dir: string = pichatDir()): string {
    return path.join(dir, "weixin", "cursor.json");
}

/**
 * 回信要带的凭据（微信的 context_token，每个来信的人一份，随来信刷新）。
 * 推送是隔了一段时间才发的，手上得留着最近一份才发得出去（见 weixinInbox.ts）。
 */
export function weixinContextFile(dir: string = pichatDir()): string {
    return path.join(dir, "weixin", "context.json");
}

/** 往微信里发过哪些提醒（服务端 message_id → 是哪个会话）：引用回复要把两边对上。 */
export function weixinSentFile(dir: string = pichatDir()): string {
    return path.join(dir, "weixin", "sent.json");
}
