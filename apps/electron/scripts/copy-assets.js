// tsc 编译后：
// 1) 把 Electron renderer 静态源（app.js/app.css/viewer.html）拷到 out/.../renderer/
// 2) 把共用前端资源（源在 apps/vscode/media）拷到 out/.../renderer/
// 3) 用已编译的 @chat-ui renderHTML 生成 out/.../renderer/index.html
const fs = require("fs");
const path = require("path");

const electronDir = path.join(__dirname, "..");
const root = path.join(electronDir, "..", "..");
const outRenderer = path.join(electronDir, "out", "apps", "electron", "renderer");
const rendererSrc = path.join(electronDir, "renderer");          // Electron 专属静态源
const chatUiAssets = path.join(root, "apps", "vscode", "media"); // 共用前端资源源（打包根内，单一真源）

fs.mkdirSync(outRenderer, { recursive: true });

// 1) Electron renderer 静态源
for (const f of ["app.js", "app.css", "viewer.html"]) {
    fs.copyFileSync(path.join(rendererSrc, f), path.join(outRenderer, f));
}

// 2) chat-ui 前端资源（chat.css 用于 renderHTML 读取内联）
//    源在 apps/vscode/media（vscode 插件的打包根，无需拷贝即可被 vsce 纳入）；
//    electron 打包根为 apps/electron，故需拷进 out/.../renderer/。
const ASSETS = ["chat.js", "chat.css", "marked.js", "highlight.js", "default-models.json", "settings.js"];
for (const f of ASSETS) {
    fs.copyFileSync(path.join(chatUiAssets, f), path.join(outRenderer, f));
}

// 3) 生成 index.html：require 已编译的 chat-ui（out/src/chat-ui/index.js）
const { renderHTML } = require(path.join(electronDir, "out", "src", "chat-ui", "index.js"));
const chatCss = fs.readFileSync(path.join(chatUiAssets, "chat.css"), "utf8");

const html = renderHTML({
    resolveUri: (name) => name, // 相对 index.html 同目录
    csp: "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    chatCss,
    extraHead: '<link rel="stylesheet" href="app.css" />',
    extraBodyTop: `  <div id="appBar">
    <button id="projectBtn" class="bar-btn" title="切换项目">📂 <span id="projectName">未选择项目</span></button>
    <div id="projectMenu" class="hidden"></div>
    <div class="bar-spacer"></div>
    <button id="historyBtn" class="bar-btn" title="历史会话"> 历史</button>
    <button id="viewOptsBtn" class="bar-btn" title="显示选项"> 显示</button>
    <button id="settingsBtn" class="bar-btn" title="编辑 models.json"> 设置</button>
  </div>
  <div id="appOverlay" class="hidden"><div id="appModal"></div></div>`,
    extraScripts: ["settings.js", "app.js"],
});
fs.writeFileSync(path.join(outRenderer, "index.html"), html, "utf8");
console.log("[copy-assets] out/.../renderer/ 已生成（静态源 + 资源 + index.html）");
