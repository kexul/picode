// @ts-nocheck
/**
 * lazyScripts —— 验「按需加载的那几个脚本真的没排进首屏」（现在只有 pele，画 mermaid 图用的，700 多 KB）。
 *
 * 两种装法各验一遍：
 *   - 浏览器页面：<script src> 里没有 pele.js，head 的 meta 里写着带内容指纹的地址，
 *     地址能原样解回来（页面里的加载器就照这个读，见 chat.js 的 loadMermaidLib）；
 *   - 面板：pele 仍然内联在整页里（面板没有可引的资源地址），也不该出现那份 meta。
 *
 *   npm run compile && node dev/lazyScripts.js
 *
 * 只拼页面、不开浏览器：画不画得出图是 mermaidCheck.js 的事，这里只管“什么时候去取”。
 */
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const { getBrowserChatHtml, getPanelChatHtml } = require(path.join(repoRoot, "out", "server", "pageHtml.js"));

const mediaDir = path.join(repoRoot, "media");
const browser = getBrowserChatHtml(mediaDir, "pid-test", "dark");
const panel = getPanelChatHtml(mediaDir, { themeMode: "dark" });

const scriptSrc = (html) => Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g)).map((m) => m[1]);
const metaTag = /<meta name="pichat-lazy-scripts" content="([^"]*)"/.exec(browser);

/** 浏览器读 meta 的 content 时拿到的是解码后的样子：这里照 HTML 实体解回去再解 JSON。 */
function lazyUrls() {
    try {
        const raw = metaTag[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

const checks = [
    ["浏览器页面：首屏 <script src> 里没有 pele", !scriptSrc(browser).some((s) => s.includes("pele"))],
    ["浏览器页面：head 里写了按需地址，带着内容指纹", !!metaTag && /pele\.js\?v=[0-9a-f]{6,}/.test(metaTag[1])],
    ["浏览器页面：那份地址能解回来（页面里的加载器就这么读）", typeof lazyUrls()["pele.js"] === "string" && lazyUrls()["pele.js"].includes("pele.js")],
    ["浏览器页面：其余第三方脚本照旧在首屏", scriptSrc(browser).some((s) => s.includes("marked")) && scriptSrc(browser).some((s) => s.includes("highlight"))],
    ["浏览器页面：主脚本仍然排在最后", (scriptSrc(browser).slice(-1)[0] || "").includes("chat.js")],
    ["面板：pele 仍然内联进来（它没有可引的资源地址）", /Pele \d+\.\d+/.test(panel)],
    ["面板：不给按需地址", !panel.includes('<meta name="pichat-lazy-scripts"')],
];

let bad = 0;
for (const [name, ok] of checks) {
    if (!ok) { bad += 1; }
    console.log((ok ? "OK   " : "FAIL ") + name);
}
console.log(bad === 0 ? "\n全部通过。" : `\n${bad} 条没过。`);
process.exit(bad === 0 ? 0 : 1);
