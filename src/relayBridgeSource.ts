/**
 * pi 里的桥接扩展往「中转」事件口报事的那一小段代码（拼进每个桥的源码里）。
 *
 * 为什么要拼进去、不是写成一个共用的 .ts 让桥 import：桥是插件生成在
 * `~/.pi/pichat/*-bridge-<版本>.ts` 的独立文件，pi 用 `-e <文件>` 一个个加载，
 * 再引一个同目录的文件就得指望两边对相对路径 / 扩展名 / TS 加载方式的理解完全一致 ——
 * 生成的源码里没有 import 最稳。所以这一份在仓库里只有一处，四个桥各自拼一份进去。
 *
 * 桥那边拿到的几个环境变量（起 pi 时由中转塞进来，见 relayMain.ts 的 spawnOne）：
 *   - PICHAT_RELAY_URL   事件口地址（http://127.0.0.1:端口/）
 *   - PICHAT_RELAY_TOKEN 口令
 *   - PICHAT_PI_KEY      这只 pi 的名字（后端靠它认出"这是哪个会话"）
 *
 * 报出去的事件如果有回执（提问、派活），桥拿 replyId 去 `/reply` 长轮询等答案。
 * 换后端（编译并重启）时，还没答的那些会由中转再推一遍 —— 这就是"重启以后那道题还在"。
 *
 * @param httpName 桥文件里 http 模块的本地名字（桥自己 import，外面替它带上）
 */
export function relayClientCode(httpName: string): string {
    return String.raw`
// ---- 中转的事件口（见 src/relayBridgeSource.ts）----
const RELAY_URL = (process.env.PICHAT_RELAY_URL || "").trim();
const RELAY_TOKEN = (process.env.PICHAT_RELAY_TOKEN || "").trim();
const RELAY_KEY = (process.env.PICHAT_PI_KEY || "").trim();
const relayAgent = new ${httpName}.Agent({ keepAlive: true });

/** 有没有中转可用（没有就退回原来的 stderr / 回话文件那条路）。 */
function relayReady() {
    return RELAY_URL !== "" && RELAY_TOKEN !== "" && RELAY_KEY !== "";
}

/** 往事件口发一次请求（GET / POST），回 JSON；连不上 / 读不懂都当没有。 */
function relayCall(method, pathAndQuery, body, timeoutMs) {
    return new Promise((resolve) => {
        if (!relayReady()) { resolve(undefined); return; }
        let target;
        try { target = new URL(pathAndQuery, RELAY_URL); } catch { resolve(undefined); return; }
        const payload = body === undefined ? "" : JSON.stringify(body);
        const req = ${httpName}.request({
            host: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method,
            agent: relayAgent,
            headers: Object.assign(
                { "x-pichat-token": RELAY_TOKEN },
                payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
            ),
            timeout: timeoutMs,
        }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => {
                try { resolve(JSON.parse(text)); } catch { resolve(undefined); }
            });
        });
        req.on("error", () => resolve(undefined));
        req.on("timeout", () => { try { req.destroy(); } catch { /* 算了 */ } resolve(undefined); });
        req.end(payload);
    });
}

/** 报一件事；要回执的那种（提问 / 派活）会带回 replyId。 */
function relayPost(kind, id, payload) {
    return relayCall("POST", "/event", { key: RELAY_KEY, kind: kind, id: id, payload: payload }, 10000)
        .then((got) => (got && typeof got === "object" ? got : { ok: false, reason: "中转没回应" }));
}

/** 等回执（长轮询）：arrived 是答案，pending 是还没人答，unknown 是中转不认识这次提问。 */
function relayWait(replyId, waitMs) {
    return relayCall("GET", "/reply?wait=" + waitMs + "&replyId=" + encodeURIComponent(replyId), undefined, waitMs + 5000)
        .then((got) => (got && typeof got === "object" ? got : { state: "unknown" }));
}

/** 不等了：把还挂着的这题从中转那儿摘掉（不然换后端时还会再推一遍）。 */
function relayCancel(id) {
    return relayPost("ask-cancel", id, {});
}
`;
}
