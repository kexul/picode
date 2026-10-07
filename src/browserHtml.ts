import * as fs from "fs";
import * as path from "path";
import { renderHTML } from "./renderHtml";

/**
 * browserHtml —— 生成"在浏览器里打开"的对话页面 HTML。
 *
 * 与 chatHtml.ts（VSCode 网页视图用）走同一个 renderHTML()，界面结构、chat.js、
 * chat.css 完全一致，只有三处不同：
 *   1. 资源地址用普通路径 /media/xxx（浏览器直接由网页服务提供），不用 vscode-webview: 那种地址；
 *   2. 内容安全策略按浏览器的规则写（脚本只能来自本站，不允许内联脚本与外部站点）；
 *   3. 先在 chat.js 之前加载 media/browserBridge.js（它把"VSCode 网页视图的消息通道"
 *      换成网页服务上的收发），并补一份网页专用的样式（颜色与输入框高度）。
 *
 * 另外一份差别：VSCode 那份会藏掉界面底部的按钮条（那些按钮由 VSCode 面板标题栏提供），
 * 浏览器里没有标题栏，所以按钮条照常显示，并由 browserBridge.js 往里面补几个按钮。
 */

/**
 * 生成浏览器页面的 HTML 全文。
 * @param mediaDir 插件安装目录下的 media 目录（读 chat.css 文本用）
 * @param pageId 本页面的标识：服务靠它认出“当前是哪一个页面”，
 *               页面发的每条消息都要带上它
 */
export function getBrowserChatHtml(mediaDir: string, pageId: string): string {
    let chatCss = "";
    try {
        chatCss = fs.readFileSync(path.join(mediaDir, "chat.css"), "utf8");
    } catch { /* 读不到就只少样式，界面仍能跑 */ }

    // 浏览器专用的那一份也用内联：导出会话时 chat.js 只抓 <style> 里的内容，
    // 用 <link> 引的话导出的 HTML 里就没有颜色了。
    let browserCss = "";
    try {
        browserCss = fs.readFileSync(path.join(mediaDir, "browserTheme.css"), "utf8");
    } catch { /* 同上：读不到只是少颜色与单行输入框 */ }

    const mediaUrl = (name: string) => `/media/${name}`;

    // 浏览器页面的安全策略（无内联脚本、不加载外部站点的东西）
    const csp =
        `default-src 'none'; ` +
        `img-src 'self' data: blob:; ` +
        `media-src blob:; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `script-src 'self'; ` +
        `connect-src 'self'; ` +
        `font-src 'self'; ` +
        `base-uri 'none'; ` +
        `form-action 'none';`;

    const extraHead =
        `<title>Pi Chat（浏览器）</title>\n` +
        `  <meta name="pichat-page" content="${escapeAttr(pageId)}" />\n` +
        `  <style id="browser-theme">\n${browserCss}\n</style>`;

    // extraBodyBottom 被 renderHTML 放在所有 <script> 之前：浏览器桥必须比 chat.js 先加载，
    // 否则 chat.js 一开头调用 acquireVsCodeApi() 就会因为函数不存在而报错。
    const extraBodyBottom = `<script src="${mediaUrl("browserBridge.js")}"></script>`;

    return renderHTML({
        resolveUri: mediaUrl,
        csp,
        chatCss,
        extraHead,
        extraBodyBottom,
        extraScripts: [mediaUrl("settings.js")],
    });
}

/** 写进 HTML 属性前转义引号等字符（页面标识是随机串，这里只是防万一）。 */
function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
