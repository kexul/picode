import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { renderHTML } from "../../../src/chat-ui";

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

/**
 * 生成聊天 Webview 的 HTML。
 * 聊天 DOM/JS 来自共用源 src/chat-ui（编译进 out），这里注入 VSCode 特有的
 * URI 解析、CSP（含 nonce + cspSource）、chat.css 文本。
 * 前端资源（chat.js/marked.js/highlight.js/chat.css）的源就是本插件 media/ 目录
 * （位于 vsce 打包根内，无需拷贝，直接由 webview 加载 / 读取内联）。
 */
export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const n = nonce();
    const resolveUri = (name: string) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
    // chat.css 内联进 <style>：从 media/chat.css 读取文本
    const cssPath = vscode.Uri.joinPath(extensionUri, "media", "chat.css").fsPath;
    let chatCss = "";
    try { chatCss = fs.readFileSync(cssPath, "utf8"); } catch { /* ignore */ }
    const csp =
        `default-src 'none'; ` +
        `img-src ${webview.cspSource} data:; ` +
        `style-src 'unsafe-inline'; ` +
        `script-src 'nonce-${n}';`;

    return renderHTML({ resolveUri, csp, chatCss, scriptNonce: n });
}
