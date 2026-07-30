// Electron 渲染进程预加载脚本。
// 为复用自 @pi/chat-ui 的 assets/chat.js 提供 acquireVsCodeApi() 兼容 shim，
// 把 VSCode webview 的 postMessage 桥接到 Electron ipcRenderer。
const { ipcRenderer } = require("electron");

const api = {
    postMessage(msg: unknown) {
        ipcRenderer.send("pc", msg);
    },
};

(window as any).acquireVsCodeApi = () => api;
// 宿主标识：chat.js 据此在 Electron 下关闭符号链接（无 LSP，点了没意义）
(window as any).__PI_HOST__ = "electron";

ipcRenderer.on("ph", (_e: unknown, msg: unknown) => {
    // 转发为 window message 事件，复用 chat.js 的监听逻辑
    (window as any).postMessage(msg, "*");
});
