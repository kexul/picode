import * as http from "http";

/**
 * chatHtml —— 插件里那块对话面板的界面从哪儿来。
 *
 * 整页 HTML（骨架 + 样式 + 全部脚本）都由后端现拼现给（见 pageHtml.getPanelChatHtml），
 * 插件这边只剩“去要一份”这件事：不再自己拼骨架，也不再各抓一份界面文件。
 *
 * 为什么整页要交给后端：以前骨架编在插件包里、脚本从后端 /media/ 现抓，插件和后端是
 * 两个各自能升级的包，两边版本一错开就是“页面起得来、行为不对”，界面上还什么都不说。
 * 现在骨架与脚本必然出自同一次构建。
 *
 * 抓取放在插件进程里（Node 的 http），不放网页视图里自己去网络上加载 ——
 * 只有插件进程保证连得上后端；远程 SSH / 容器这类场景里，网页视图要自己访问的
 * 地址指到的是用户本机，不是后端那台机器。抓回来整份内联，CSP 也不用为后端地址开口子。
 */

/** 取回面板整页的结果。连不上 / 超时不算“结果”，见 {@link fetchPanelHtml} 的返回值。 */
export type PanelHtml =
    /** 拿到整页，直接塞进网页视图。 */
    | { kind: "html"; html: string }
    /** 后端回了个错页（多半是版本对不上：插件比后端新，后端还没有这个地址）。 */
    | { kind: "http"; note: string };

/**
 * 从后端取面板的整页 HTML。
 *
 * @returns 取到 / 后端回了错页；**连不上、超时、没地址时返回 undefined** ——
 *          那种情况一会儿再试就行（后端多半正在重启）
 */
export async function fetchPanelHtml(
    baseUrl: string,
    opts: { themeMode: "light" | "dark"; imgCspSource: string },
    timeoutMs = 5000,
): Promise<PanelHtml | undefined> {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, "") + "/panel";
    url.searchParams.set("theme", opts.themeMode);
    url.searchParams.set("csp", opts.imgCspSource);
    let status: number;
    let body: string;
    try {
        ({ status, body } = await request(url, timeoutMs));
    } catch {
        return undefined;
    }
    if (status === 200) { return { kind: "html", html: body }; }
    const words = body.trim().slice(0, 200) || "（没有说明）";
    // 404 只会在“插件比后端新”（后端还没这个地址）时出现，这一句省得人自己猜
    const hint = status === 404 ? "插件比后端新？重启后端（pichat）再试。" : "";
    return { kind: "http", note: `后端给不出界面（HTTP ${status}）：${words}${hint}` };
}

/** GET 一个地址，拿回状态码与文本；超时、连不上都抛错。 */
function request(url: URL, timeoutMs: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        // 明确要原文：这份抓回来的内容要直接塞进网页视图，本函数不会解压。
        // （后端对能收 gzip 的请求会压了再发；带上这个头就不用依赖“Node 默认不发 Accept-Encoding”这件事。）
        const req = http.get(url, { headers: { "Accept-Encoding": "identity" } }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => { body += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            res.on("error", reject);
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new Error("请求超时")); });
        req.on("error", reject);
    });
}
