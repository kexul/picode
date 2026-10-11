import * as vscode from "vscode";
import * as fs from "fs";
import { renderHTML } from "./renderHtml";

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * 32));
    }
    return text;
}

/**
 * 生成聊天 Webview 的 HTML。
 * 聊天 DOM/JS 由 renderHtml.ts 生成骨架，这里注入 VSCode 特有的 URI 解析、
 * CSP（含 nonce + cspSource）、chat.css（withBridge 时再内联 browserTheme.css）文本。
 *
 * withBridge：加载 browserBridge.js（网页端那套界面件：常显标签栏、桌面截图 / ⋯ / 停止生成
 * 按钮、一行起步的输入框、按 themeMode 上色）。桥认得出自己跑在网页视图里，
 * 消息通道保持 postMessage 不变。侧边栏（与网页页面同源的那份界面）用它；
 * 编辑器区的独立工作区保持老样子，不用。
 * 前端资源（chat.js/marked.js/highlight.js/chat.css）的源就是本插件 media/ 目录
 * （位于 vsce 打包根内，无需拷贝，直接由 webview 加载 / 读取内联）。
 */
export function getChatHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    opts?: { withBridge?: boolean; themeMode?: "light" | "dark" },
): string {
    const n = nonce();
    const withBridge = opts?.withBridge ?? false;
    const themeMode = opts?.themeMode ?? "light";
    const resolveUri = (name: string) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
    // CSS 内联进 <style>：从 media/ 读取文本
    const readMedia = (name: string): string => {
        try {
            return fs.readFileSync(vscode.Uri.joinPath(extensionUri, "media", name).fsPath, "utf8");
        } catch { return ""; }
    };
    const chatCss = readMedia("chat.css");
    const browserCss = withBridge ? readMedia("browserTheme.css") : "";
    const settingsJs = resolveUri("settings.js");

    const headParts: string[] = [];
    if (withBridge) {
        // 界面颜色由 browserBridge.js 按 themeMode 上色；VSCode 注入的主题变量里
        // 调色板没覆盖的那些照常生效。
        headParts.push(`<meta name="pichat-theme" content="${themeMode}" />`);
        headParts.push(`<style id="browser-theme">${browserCss}</style>`);
    }
    const extraHead = headParts.join("\n  ");
    // 桥必须比 chat.js 先加载（chat.js 一开头就调 acquireVsCodeApi），renderHTML 把
    // extraBodyBottom 放在所有 <script> 之前，正好。
    const extraBodyBottom = withBridge ? `<script nonce="${n}" src="${resolveUri("browserBridge.js")}"></script>` : "";
    const csp =
        `default-src 'none'; ` +
        `img-src ${webview.cspSource} data:; ` +
        `style-src 'unsafe-inline'; ` +
        `script-src 'nonce-${n}';`;

    return renderHTML({ resolveUri, csp, chatCss, scriptNonce: n, extraHead, extraBodyBottom, extraScripts: [settingsJs] });
}
