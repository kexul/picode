import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renderHTML } from "./renderHtml";
import { mediaVersion } from "./mediaVersion";
import { chatUiFileOfRole, chatUiFilesOfRole } from "./chatUiFiles";
import { readServerConfig } from "./serverConfig";
import { stripForWire } from "./stripText";

/**
 * pageHtml —— 生成对话界面的整页 HTML：同一份骨架、同一份清单，两种装法。
 *
 *   - {@link getBrowserChatHtml}：浏览器页面。样式与脚本走 `/media/xxx?v=指纹`
 *     （浏览器能长期缓存），安全策略只放本站，页面标识与初始颜色写进 meta；
 *   - {@link getPanelChatHtml}：插件里那块对话面板。样式与脚本全部内联
 *     （网页视图里没有可引的资源地址，安全策略用 nonce）。
 *
 * 两种都由后端生成。面板那边以前是自己拼骨架（骨架编在插件包里）、脚本从后端 `/media/`
 * 现抓 —— 插件的骨架与后端给的脚本一错开，就是“页面起得来、行为不对”，而且没有任何提示。
 * 现在面板整页也由后端给，骨架和脚本必然出自同一次构建。
 */

/** 读 media/ 下某个文件的文本；读不到就当空（只少一块样式/脚本，界面仍旧起得来）。 */
function readMedia(mediaDir: string, name: string): string {
    try {
        // 发出去的都先去掉注释（源码不动；理由与规则见 src/stripText.ts）
        return stripForWire(name, fs.readFileSync(path.join(mediaDir, name), "utf8"));
    } catch { /* 见上 */ }
    return "";
}

/**
 * 那个标记：以前 exe 和托盘用的那一枚 —— 浅色圆角方底、深色标记、右下那根竖线是红的
 * （画它的 bin/makeicon.cs 跟着桌面程序一起退休了，坐标照那份搬过来）。
 *
 * 只存这一份 SVG：标签页的图标用它（下面转成 data 地址内联），
 * 浏览器「安装成应用」那份清单里的图标也用它（/icon.svg）。
 */
export const PAGE_ICON_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560">',
    // 方底：radius = 边长 × 0.22，边线宽 = 边长 / 48（跟原来那份画法一致）
    '<rect x="0.5" y="0.5" width="559" height="559" rx="123" fill="#F6F6F6" stroke="#303030" stroke-width="11.7"/>',
    // 标记：在方底里留一圈边距（16%），三块里右下那根用红
    '<g transform="translate(89.6 89.6) scale(0.68)">',
    '<polygon points="420,280 280,280 280,140 0,140 0,0 420,0" fill="#111111"/>',
    '<polygon points="560,560 420,560 420,280 560,280" fill="#E53935"/>',
    '<polygon points="140,560 0,560 0,140 140,140 140,280 280,280 280,420 140,420" fill="#111111"/>',
    '</g>',
    '</svg>',
].join("");

/** 标签页上那颗图标（内联的 data 地址：不用再多一次请求）。 */
const PAGE_ICON = "data:image/svg+xml," + encodeURIComponent(PAGE_ICON_SVG);

/**
 * 浏览器「安装成应用」用的清单（见 webChatServer 的 `/manifest.webmanifest`）。
 *
 * 有了它，Chrome / Edge 地址栏或菜单里就会出现「安装」（Edge 叫「应用 → 安装此站点」），
 * 装出来的东西是一个没有标签条、没有地址栏的独立窗口，跟用 `--app=` 开出来的那个一样。
 * 注意：浏览器只给「安全来源」装（https，或者本机的 127.0.0.1 / localhost）；
 * 同一网络上 http://别的机器:端口 这种不会出现「安装」（那条路用 `pichat --open` 或提醒卡片）。
 */
export function webAppManifest(): Record<string, unknown> {
    const title = pageTitle();
    return {
        name: title,
        short_name: title,
        // 开出来落在最近那个会话上（跟直接打开地址一样）
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#F6F6F6",
        theme_color: "#F6F6F6",
        icons: [{ src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" }],
    };
}

/**
 * 生成浏览器页面的 HTML 全文。
 * @param mediaDir 插件安装目录下的 media 目录（读样式与脚本用）
 * @param pageId 本页面的标识：服务靠它认出"当前是哪一个页面"，
 *               页面发的每条消息都要带上它
 * @param themeMode 初始界面颜色（显示选项里的"界面颜色"）
 */
export function getBrowserChatHtml(mediaDir: string, pageId: string, themeMode: "light" | "dark"): string {
    const browserCss = readMedia(mediaDir, chatUiFileOfRole("theme-style").name);

    // 地址里带上这份文件的内容指纹：文件没变时浏览器直接用自己存的那份（手机上刷新就不用
    // 每次重下 233KB 的 chat.js），文件改了地址跟着变，不会看到旧界面（见 mediaVersion.ts）。
    const mediaUrl = (name: string) => {
        const version = mediaVersion(mediaDir, name);
        return version ? `/media/${name}?v=${version}` : `/media/${name}`;
    };

    // 浏览器页面的安全策略（无内联脚本、不加载外部站点的东西）
    const csp =
        `default-src 'none'; ` +
        // 文件侧边栏里把会话目录里的 html 当网页打开：那个 iframe 吃的是自己的 `/site/…` 地址
        //（它里面的样式、脚本、图片归它自己那份文档管，不受这里管）。
        `frame-src 'self'; ` +
        `img-src 'self' data: blob:; ` +
        `media-src blob:; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `script-src 'self'; ` +
        `connect-src 'self'; ` +
        `font-src 'self'; ` +
        `base-uri 'none'; ` +
        // 装成应用那份清单（/manifest.webmanifest）也得放行
        `manifest-src 'self'; ` +
        `form-action 'none';`;

    // 按需加载的脚本（现在只有 pele，画 mermaid 图用的）不排进首屏，地址写进 meta，主脚本真要用时自己去拉。
    // 地址放这儿而不是写死在 chat.js 里，是为了让它带着内容指纹（见 mediaVersion.ts）。
    const lazyScripts = chatUiFilesOfRole("lazy-script");
    const lazyMeta = lazyScripts.length === 0 ? "" :
        `\n  <meta name="pichat-lazy-scripts" content="${escapeAttr(JSON.stringify(
            Object.fromEntries(lazyScripts.map((file) => [file.name, mediaUrl(file.name)]))))}" />`;
    const extraHead =
        `<title>${escapeAttr(pageTitle())}</title>\n` +
        // 图标：标签页、装成应用以后那个窗口的图标（Windows 任务栏、Alt+Tab）都用它
        `  <link rel="icon" type="image/svg+xml" href="${escapeAttr(PAGE_ICON)}" />\n` +
        // 浏览器「安装成应用」那份清单：装出来的就是一个没有标签条的独立窗口
        `  <link rel="manifest" href="/manifest.webmanifest" />\n` +
        `  <meta name="pichat-page" content="${escapeAttr(pageId)}" />\n` +
        `  <meta name="pichat-theme" content="${themeMode}" />${lazyMeta}\n` +
        `  <style id="browser-theme">${browserCss}</style>`;

    // extraBodyBottom 被 renderHTML 放在所有 <script> 之前：浏览器桥必须比 chat.js 先加载，
    // 否则 chat.js 一开头调用 acquireVsCodeApi() 就会因为函数不存在而报错。
    const extraBodyBottom = `<script src="${mediaUrl(chatUiFileOfRole("bridge").name)}"></script>`;

    return renderHTML({
        csp,
        // 主样式（154 KB）走外链：整页 HTML 是 no-store（里面写着页面标识），每次打开都会重下，
        // 样式内联在里面的活动不动就是四十几 KB；外链地址带指纹，浏览器能一直存着。
        chatCssHref: mediaUrl(chatUiFileOfRole("chat-style").name),
        extraHead,
        extraBodyBottom,
        // 第三方脚本 + 主脚本，排的先后照清单来（见 chatUiFiles.ts）。按需脚本不在这里：
        // 它的地址在 head 的 meta 里，主脚本要用时自己去拉（当前只有 pele）。
        scripts: chatUiFilesOfRole("vendor-script", "main-script").map((file) => ({ src: mediaUrl(file.name) })),
    });
}

/**
 * 生成插件里那块对话面板的 HTML 全文：样式与全部脚本内联，脚本顺序照清单来。
 *
 * 安全策略里的图片来源只写 data: 和 blob:：消息里的图片按老规矩是数据地址，
 * 面板本身也不用本地资源，用不着宿主的 cspSource（那是给网页视图里加载本地文件用的）。
 *
 * @throws 内容里有 HTML 内联不安全的序列时抛错（不该悄悄装一屏坏页面）
 */
export function getPanelChatHtml(
    mediaDir: string,
    opts: { themeMode: "light" | "dark" },
): string {
    const inline = new Map<string, string>();
    // 面板里没有可引的资源地址（见文件头），按需脚本也只能内联进来：主脚本一加载就发现
    // globalThis.pele 已经在，等于“永远不用去拉”。
    for (const file of chatUiFilesOfRole("bridge", "vendor-script", "lazy-script", "main-script")) {
        const code = escapeInlineScript(readMedia(mediaDir, file.name));
        if (endsInDoubleEscape(code)) {
            throw new Error(`界面文件 ${file.name} 里有 HTML 内联不安全的序列（<!-- 后面跟 <script），先改掉这个文件再内联。`);
        }
        inline.set(file.name, code);
    }
    const inlineOf = (role: Parameters<typeof chatUiFileOfRole>[0]): string =>
        inline.get(chatUiFileOfRole(role).name) ?? "";

    const n = nonce();
    const csp =
        `default-src 'none'; ` +
        `img-src data: blob:; ` +
        `style-src 'unsafe-inline'; ` +
        `script-src 'nonce-${n}';`;

    // 界面颜色由 browserBridge.js 按 themeMode 上色；VSCode 注入的主题变量里
    // 调色板没覆盖的那些照常生效。
    const extraHead =
        `<meta name="pichat-theme" content="${opts.themeMode}" />\n` +
        `  <style id="browser-theme">${readMedia(mediaDir, chatUiFileOfRole("theme-style").name)}</style>`;
    // 桥必须比 chat.js 先加载（chat.js 一开头就调 acquireVsCodeApi）：
    // renderHTML 把 extraBodyBottom 放在所有 <script> 之前，正好。
    const extraBodyBottom = `<script nonce="${n}">${inlineOf("bridge")}</script>`;

    return renderHTML({
        csp,
        chatCss: readMedia(mediaDir, chatUiFileOfRole("chat-style").name),
        scriptNonce: n,
        extraHead,
        extraBodyBottom,
        scripts: chatUiFilesOfRole("vendor-script", "lazy-script", "main-script").map((file) => ({
            content: inline.get(file.name) ?? "",
        })),
    });
}

/**
 * 这个页面的标题（`<标签>-pi`）：浏览器 tab 上写的、「安装成应用」装出来那个窗口上写的、
 * 任务栏与 Alt+Tab 里写的，都是它。
 *
 * 人点右下角那张提醒卡片时，画卡片的那支小程序也按它去 Windows 上找那个窗口
 * （见 desktopNotice 的 raise）。所以这份拼法只有这一处，别在别的地方再写一遍。
 */
export function pageTitle(): string {
    const host = displayName();
    return host ? `${host}-pi` : "pi";
}

/**
 * 设置里那行「标签」（页面标题、提醒卡片左上角那颗小标签都用它），
 * 没写就用机器名（`GIH-D-26741` 这种）。
 */
export function displayName(): string {
    try {
        const label = readServerConfig().config.label;
        if (label) { return label; }
    } catch { /* 读不到设置就用机器名 */ }
    return machineName();
}

/**
 * 这台机器的名字（系统里的主机名）。取不到就空串。
 * 主机名可能带引号、尖括号这类字符，写进 HTML 前照样 {@link escapeAttr} 转义。
 */
export function machineName(): string {
    try {
        return os.hostname();
    } catch { /* 见上 */ }
    return "";
}

/** 面板那份安全策略的 nonce（随机串，写进哪几个脚本标签就是哪几段能跑）。 */
function nonce(): string {
    return crypto.randomBytes(16).toString("hex");
}

/**
 * 内联进 `<script>` 的转义：内容里出现字面的 `</script>` 会把标签提前收掉，
 * 后半段就被当成 HTML 了。替换成 `<\/script`：在字符串、模板串、正则里 `\/` 都等于 `/`，
 * 内容含义不变。
 */
function escapeInlineScript(code: string): string {
    return code.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * 内联脚本的安全检查（HTML 解析的"双转义"坑）。
 *
 * 脚本内容里先出现 `<!--`、后又出现 `<script`（中间没有 `-->`）时，HTML 解析器会进入
 * "双重转义"状态：在那之后真正的 `</script>` 收不掉标签，整个页面就装不起来了。
 * 注意这跟 JS 语义无关，解析器扫的是原文 —— 字符串里的 `<!--` 也算。
 * 有这个序列的文件不能内联，得先把文件改掉。
 */
function endsInDoubleEscape(code: string): boolean {
    // 从最后一个 --> 往后看：那段里只要有 <!-- 后面跟 <script，收尾就收不住
    const close = code.lastIndexOf("-->");
    const tail = close >= 0 ? code.slice(close + 3) : code;
    const open = tail.indexOf("<!--");
    if (open < 0) { return false; }
    return /<script/i.test(tail.slice(open + 4));
}

/** 写进 HTML 属性前转义引号等字符（页面标识是随机串，这里只是防万一）。 */
function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
