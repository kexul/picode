/**
 * 界面由哪几个文件组成：一份清单，两处从它派生（都在后端）。
 *
 *   - 网页服务放行哪些静态文件（webTransport 的文件名白名单）；
 *   - 整页怎么拼：浏览器页面怎么排（pageHtml.getBrowserChatHtml）、
 *     面板页面怎么内联（pageHtml.getPanelChatHtml）。
 *
 * 加一个界面文件时只改这里（数组顺序就是加载顺序）。角色说明它在界面里干什么，
 * 决定谁在什么时候用它：样式进 <style>，桥必须比主脚本先加载，第三方脚本排在主脚本之前。
 */
export type ChatUiRole =
    /** 主样式：进首屏的 <style>（renderHTML 的 chatCss）。 */
    | "chat-style"
    /** 主题样式：进 <style id="browser-theme">（桥一加载就按它上色）。 */
    | "theme-style"
    /** 桥：必须比主脚本先加载（主脚本一开头就调 acquireVsCodeApi）。 */
    | "bridge"
    /** 第三方脚本：排在主脚本之前。 */
    | "vendor-script"
    /** 主脚本：最后加载的那一个。 */
    | "main-script";

export interface ChatUiFile {
    /** media/ 下的文件名。 */
    name: string;
    /** 它在这套界面里干什么。 */
    role: ChatUiRole;
}

/** 界面用到的全部文件，按加载顺序。 */
export const CHAT_UI_FILES: readonly ChatUiFile[] = [
    { name: "chat.css", role: "chat-style" },
    { name: "browserTheme.css", role: "theme-style" },
    { name: "browserBridge.js", role: "bridge" },
    { name: "marked.js", role: "vendor-script" },
    { name: "highlight.js", role: "vendor-script" },
    { name: "chat.js", role: "main-script" },
];

/** 清单里的文件名：网页服务的白名单用它。 */
export const CHAT_UI_FILE_NAMES: readonly string[] = CHAT_UI_FILES.map((file) => file.name);

/** 一种角色只有一个文件的那几份（主样式 / 主题样式 / 桥 / 主脚本）。 */
export function chatUiFileOfRole(role: ChatUiRole): ChatUiFile {
    const found = CHAT_UI_FILES.find((file) => file.role === role);
    if (!found) {
        throw new Error(`界面清单里没有「${role}」这个角色的文件（见 chatUiFiles.ts）`);
    }
    return found;
}

/** 按清单顺序取这几种角色的文件（第三方脚本 + 主脚本的加载顺序就是这么来的）。 */
export function chatUiFilesOfRole(...roles: ChatUiRole[]): ChatUiFile[] {
    return CHAT_UI_FILES.filter((file) => roles.includes(file.role));
}
