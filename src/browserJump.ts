/**
 * browserJump —— 叫浏览器把某一张标签页切到前面（走浏览器自带的调试接口）。
 *
 * 干什么：人点了右下角那张提醒卡片，要把开着页面的那个地方弄到人眼前。按窗口标题找那条路
 * （见 desktopNotice 的 raise）有个洞：页面停在普通浏览器窗口的**背景标签页**里的时候，
 * 窗口标题跟着活动的那张走，外面既认不出是哪扇窗口，也没有“把某一张标签页点开”的接口。
 * 这条路补的就是那个洞：浏览器要是带调试端口起着的（`--remote-debugging-port=`），那个端口上
 * 有一份“现在开着哪些页面”的清单，每张标签页**自己的**标题都在里面（不是窗口那一个），
 * 于是能按标题认出那一张，再叫一声把它切到前面。
 *
 * 一次 HTTP 请求就够（清单是 `/json/list`，切到前面是 `/json/activate/<标识>`）：
 * 实测背景标签页切到前面、最小化的窗口自己还原、窗口还到了前台，这三样一下全办了。
 *
 * 端口用约定的 9222（浏览器这边常用的那个号），要换就设环境变量 `PICHAT_BROWSER_DEBUG_PORT`。
 * 端口没开（默认就是这样）、清单里没有那张标签页、请求出错 —— 一律返回 false，
 * 由调用方退回按窗口标题找那条路（见 chatHost 的 openNotice）。
 *
 * 两条要知道的：
 *   - Chromium 136 之后不给“日常那份配置”开调试端口（Helium 是 157 内核，实测端口起不来），
 *     所以浏览器得起在另一份配置目录上（`--user-data-dir=`）；怎么起见 README。
 *   - 调试端口开着，本机任何程序都能摆布那份浏览器（翻标签、读它存的登录）。只连 127.0.0.1，
 *     外面进不来；不想拿日常那份配置冒这个险，就单独给 pi 页面开一份配置。
 */

/** 约定的调试端口（浏览器这边常用的那个号）。 */
export const DEFAULT_BROWSER_DEBUG_PORT = 9222;

/** 调试接口那份清单里的一张页面（只认这三个字段）。 */
interface DebugTarget {
    type?: string;
    title?: string;
    id?: string;
}

/** 现在用哪个调试端口：环境变量里写了就用那个（得像话），没写就用 9222。 */
export function browserDebugPort(): number {
    const wanted = Number(process.env.PICHAT_BROWSER_DEBUG_PORT);
    if (Number.isInteger(wanted) && wanted > 0 && wanted < 65536) { return wanted; }
    return DEFAULT_BROWSER_DEBUG_PORT;
}

/**
 * 叫浏览器把标题是 `title` 的那张标签页切到前面。
 * @returns 切到了没有（端口没开、没有这张、请求出错，都是 false，不抛）
 */
export function activatePageByTitle(title: string): Promise<boolean> {
    return activateTitleOnPort(title, browserDebugPort());
}

/**
 * 同上，端口自己给（验证脚本用：调试工具起浏览器时端口是当场挑的，不是 9222）。
 *
 * 好几张标签页标题一样就切最上面那张：连着后端的那些页面都会切到同一个会话，切哪张看都是对的。
 * @param title 要找的页面标题（拼法见 pageHtml 的 pageTitle）
 * @param port 浏览器的调试端口
 */
export async function activateTitleOnPort(title: string, port: number): Promise<boolean> {
    if (!title || !(port > 0)) { return false; }
    const base = `http://127.0.0.1:${port}`;
    try {
        const listed = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) });
        if (!listed.ok) { return false; }
        const targets = (await listed.json()) as unknown;
        if (!Array.isArray(targets)) { return false; }
        // 只认“页面”那种（那份清单里还有 service worker、别的标签页组之类的东西），标题一字不差
        const hit = (targets as DebugTarget[]).find((one) => one && one.type === "page" && one.title === title && typeof one.id === "string");
        if (!hit || !hit.id) { return false; }
        const done = await fetch(`${base}/json/activate/${encodeURIComponent(hit.id)}`, { signal: AbortSignal.timeout(2000) });
        return done.ok;
    } catch {
        // 端口上没人听（最常见：浏览器没带调试端口起）、连不上、超时 —— 都当“没找着”，退回另一条路
        return false;
    }
}
