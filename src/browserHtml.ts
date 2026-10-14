import * as fs from "fs";
import * as path from "path";
import { renderHTML } from "./renderHtml";
import { mediaVersion } from "./mediaVersion";
import { chatUiFileOfRole, chatUiFilesOfRole } from "./chatUiFiles";

/**
 * browserHtml —— 生成"在浏览器里打开"的对话页面 HTML。
 *
 * 与 chatHtml.ts（VSCode 网页视图用）走同一个 renderHTML()，界面结构、chat.js、
 * chat.css 完全一致，只有三处不同：
 *   1. 资源地址用普通路径 /media/xxx（浏览器直接由网页服务提供），不用 vscode-webview: 那种地址；
 *   2. 内容安全策略按浏览器的规则写（脚本只能来自本站，不允许内联脚本与外部站点）；
 *   3. 页面标识写进 meta（服务靠它认出"当前是哪一个页面"），初始界面颜色也写进 meta
 *      （browserBridge.js 一加载就按它上色）。
 *
 * 另外一份差别：VSCode 那份会把界面底部的按钮条藏掉（那些按钮由 VSCode 面板标题栏提供），
 * 浏览器里也没有标题栏，项目与会话收进了顶条最右边的"<<<"按钮（窗口够宽时它常驻在右边占一列，
 * 窄窗里从右侧滑入，见 browserBridge.js、chat.css 末尾那段与 chat.js 的常驻的项目与会话侧边栏），
 * 底部那条在浏览器里同样整条藏掉。
 */

/**
 * 生成浏览器页面的 HTML 全文。
 * @param mediaDir 插件安装目录下的 media 目录（读 chat.css 文本用）
 * @param pageId 本页面的标识：服务靠它认出"当前是哪一个页面"，
 *               页面发的每条消息都要带上它
 * @param themeMode 初始界面颜色（显示选项里的"界面颜色"）
 */
export function getBrowserChatHtml(mediaDir: string, pageId: string, themeMode: "light" | "dark"): string {
    const readMedia = (name: string): string => {
        try {
            return fs.readFileSync(path.join(mediaDir, name), "utf8");
        } catch { /* 读不到就只少样式，界面仍能跑 */ }
        return "";
    };

    // 浏览器专用的那份样式也用内联：导出会话时 chat.js 只抓 <style> 里的内容，
    // 用 <link> 引的话导出的 HTML 里就没有样式了。
    const chatCss = readMedia(chatUiFileOfRole("chat-style").name);
    const browserCss = readMedia(chatUiFileOfRole("theme-style").name);

    // 地址里带上这份文件的内容指纹：文件没变时浏览器直接用自己存的那份（手机上刷新就不用
    // 每次重下 233KB 的 chat.js），文件改了地址跟着变，不会看到旧界面（见 mediaVersion.ts）。
    const mediaUrl = (name: string) => {
        const version = mediaVersion(mediaDir, name);
        return version ? `/media/${name}?v=${version}` : `/media/${name}`;
    };

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
        `  <meta name="pichat-theme" content="${themeMode}" />\n` +
        `  <style id="browser-theme">${browserCss}</style>`;

    // extraBodyBottom 被 renderHTML 放在所有 <script> 之前：浏览器桥必须比 chat.js 先加载，
    // 否则 chat.js 一开头调用 acquireVsCodeApi() 就会因为函数不存在而报错。
    const extraBodyBottom = `<script src="${mediaUrl(chatUiFileOfRole("bridge").name)}"></script>`;

    return renderHTML({
        csp,
        chatCss,
        extraHead,
        extraBodyBottom,
        // 第三方脚本 + 主脚本，排的先后照清单来（见 chatUiFiles.ts）
        scripts: chatUiFilesOfRole("vendor-script", "main-script").map((file) => ({ src: mediaUrl(file.name) })),
    });
}

/** 写进 HTML 属性前转义引号等字符（页面标识是随机串，这里只是防万一）。 */
function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
