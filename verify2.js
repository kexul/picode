// 校验 chatHtml 生成的 HTML 结构含新元素
const { getChatHtml } = require("D:/BackUp/pi_plugin/out/chatHtml.js");
const html = getChatHtml({ asWebviewUri: (u) => u, cspSource: "" }, {});
console.log("含 modelBtn:", html.includes('id="modelBtn"'));
console.log("含 fileMenu:", html.includes('id="fileMenu"'));
console.log("含 bottomBar:", html.includes('id="bottomBar"'));
console.log("输入框 min-height 72px:", html.includes("min-height: 72px"));

// 校验 relativeTo 逻辑（复制自源码）
function relativeTo(cwd, full) {
    const norm = (s) => s.replace(/\\/g, "/");
    const c = norm(cwd).replace(/\/$/, "") + "/";
    const f = norm(full);
    if (f.toLowerCase().startsWith(c.toLowerCase())) return f.slice(c.length);
    return full;
}
console.log("同项目相对路径:", relativeTo("D:\\BackUp\\pi_plugin", "D:\\BackUp\\pi_plugin\\src\\extension.ts"));
console.log("外部保留绝对:", relativeTo("D:\\BackUp\\pi_plugin", "D:\\Other\\file.txt"));
