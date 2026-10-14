import * as http from "http";
import { renderHTML } from "./renderHtml";
import { CHAT_UI_FILE_NAMES, chatUiFileOfRole, chatUiFilesOfRole, type ChatUiFile } from "./chatUiFiles";

/**
 * chatHtml —— 插件里那块对话面板的界面从哪儿来。
 *
 * 界面文件（哪几份见 chatUiFiles.ts 那份清单）不从插件自己的 media/ 目录读，而是从正在跑的
 * 后端（pichat）的 /media/ 现取：面板看到的界面版本永远跟后端一致，后端升级后
 * 重连一次就换新版，插件自己那份 media/ 只是后端要用的一份拷贝。
 *
 * 抓取放在插件进程里（Node 的 http），不放网页视图里自己去网络上加载——
 * 只有插件进程保证连得上后端；远程 SSH / 容器这类场景里，网页视图要自己访问的
 * 地址指到的是用户本机，不是后端那台机器。
 *
 * 抓回来的内容全部内联进一份 HTML（CSS 进 <style>，JS 进带 nonce 的 <script>），
 * CSP 不用为后端地址开口子，也不需要 localResourceRoots。
 */

/** 面板要用的界面文件内容：文件名 → 原文（都是后端 /media/ 里抓回来的）。 */
export type ChatUiContents = ReadonlyMap<string, string>;

/** 取某个文件的内容。抓的时候清单里有几份就抓几份，取不到说明清单与抓取对不上了。 */
function contentOf(files: ChatUiContents, file: ChatUiFile): string {
    const text = files.get(file.name);
    if (text === undefined) {
        throw new Error(`界面文件 ${file.name} 没抓到（清单与抓取对不上？见 chatUiFiles.ts）`);
    }
    return text;
}

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * 32));
    }
    return text;
}

/**
 * 从后端把面板要用的界面文件一次抓齐（并行，任一个失败就算没抓到）。
 * @param baseUrl 后端地址（如 http://127.0.0.1:51883/）
 * @returns 抓到的全部内容；有一个文件没取到就返回 undefined
 */
export async function fetchChatUiFiles(baseUrl: string, timeoutMs = 5000): Promise<ChatUiContents | undefined> {
    const grab = (name: string): Promise<string> => {
        const url = new URL(baseUrl);
        url.pathname = (url.pathname.replace(/\/+$/, "")) + "/media/" + name;
        return fetchText(url, timeoutMs);
    };
    try {
        // 清单里有几份就抓几份，谁也别漏（漏一份就是“浏览器看得到、插件面板里没有”那类毛病）
        const texts = await Promise.all(CHAT_UI_FILE_NAMES.map((name) => grab(name)));
        return new Map(CHAT_UI_FILE_NAMES.map((name, i) => [name, texts[i]]));
    } catch {
        return undefined;
    }
}

/** GET 一个地址，拿回应的文本；非 200、超时、连不上都算失败。 */
function fetchText(url: URL, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        // 明确要原文：这份抓回来的内容要直接内联进面板的 HTML，本函数不会解压。
        // （后端对能收 gzip 的请求会压了再发；带上这个头就不用依赖“Node 默认不发 Accept-Encoding”这件事。）
        const req = http.get(url, { headers: { "Accept-Encoding": "identity" } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => { text += chunk; });
            res.on("end", () => resolve(text));
            res.on("error", reject);
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new Error("请求超时")); });
        req.on("error", reject);
    });
}

/**
 * 内联进 <script> 的转义：内容里出现字面的 </script> 会把标签提前收掉，
 * 后半段就被当成 HTML 了。替换成 <\/script：在字符串、模板串、正则里 \/ 都等于 /，
 * 内容含义不变。
 */
function escapeInlineScript(code: string): string {
    return code.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * 内联脚本的安全检查（HTML 解析的"双转义"坑）。
 *
 * 脚本内容里先出现 <!--、后又出现 <script（中间没有 -->）时，HTML 解析器会进入
 * "双重转义"状态：在那之后真正的 </script> 收不掉标签，整个页面就装不起来了。
 * 注意这跟 JS 语义无关，解析器扫的是原文——字符串里的 <!-- 也算。
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

/**
 * 拼插件里那块对话面板的 HTML：CSS 与全部 JS 内联，脚本顺序与浏览器页面一致（照清单来）。
 *
 * @param imgCspSource webview 的 cspSource：消息里的图片仍按老规矩只放数据地址
 *                     与本机资源，面板不用本地资源了但这条留着不碍事
 * @throws 内容里有内联不安全的序列时抛错（不该悄悄装一屏坏页面）
 */
export function getChatHtml(
    files: ChatUiContents,
    opts?: { themeMode?: "light" | "dark"; imgCspSource?: string },
): string {
    const themeMode = opts?.themeMode ?? "light";
    const imgCspSource = opts?.imgCspSource ?? "";
    for (const file of chatUiFilesOfRole("bridge", "vendor-script", "main-script")) {
        if (endsInDoubleEscape(escapeInlineScript(contentOf(files, file)))) {
            throw new Error(`界面文件 ${file.name} 里有 HTML 内联不安全的序列（<!-- 后面跟 <script），先改掉这个文件再内联。`);
        }
    }

    const n = nonce();
    const headParts: string[] = [
        // 界面颜色由 browserBridge.js 按 themeMode 上色；VSCode 注入的主题变量里
        // 调色板没覆盖的那些照常生效。
        `<meta name="pichat-theme" content="${themeMode}" />`,
        `<style id="browser-theme">${contentOf(files, chatUiFileOfRole("theme-style"))}</style>`,
    ];
    // 桥必须比 chat.js 先加载（chat.js 一开头就调 acquireVsCodeApi）：
    // renderHTML 把 extraBodyBottom 放在所有 <script> 之前，正好。
    const extraBodyBottom = `<script nonce="${n}">${escapeInlineScript(contentOf(files, chatUiFileOfRole("bridge")))}</script>`;
    const csp =
        `default-src 'none'; ` +
        `img-src ${imgCspSource} data:; ` +
        `style-src 'unsafe-inline'; ` +
        `script-src 'nonce-${n}';`;

    return renderHTML({
        csp,
        chatCss: contentOf(files, chatUiFileOfRole("chat-style")),
        scriptNonce: n,
        extraHead: headParts.join("\n  "),
        extraBodyBottom,
        scripts: chatUiFilesOfRole("vendor-script", "main-script").map((file) => ({
            content: escapeInlineScript(contentOf(files, file)),
        })),
    });
}
