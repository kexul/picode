/**
 * weixinPush —— 会话有事时往微信里发一条。
 *
 * 发出去的头一行是会话名（替别的机器发的再前面加一句 `哪台 · `），空一行，底下是这一轮的
 * 回复原文 —— markdown 原样发，微信自己会渲染。太长就按 `WEIXIN_CHUNK_CHARS` 切成几条接着发
 * （微信单条消息有长度上限）。没有回复文字就只发会话名那一行。
 *
 * 不写“跑完了一轮”、也不附地址：微信里看到的就是“哪个会话说了什么”，
 * 想接着聊，引用这条消息回一句就是了（那才是这件事真正的入口）。
 *
 * 为什么要发而不是只弹面板：面板只在跑后端的那台 Windows 上有，人可能在别的屋里、在外面。
 * 微信这条也不看“人是不是正坐在输入框前面”（见 chatHost.ts 的 trayNote）：那是给不在电脑前准备的。
 *
 * 发出去的每条都记下服务端给的 message_id：以后“在微信里引用这条消息回一句”要知道接哪个会话
 * （那个 id 是唯一能把两边对上的东西）。分块发出去时每块都记，引用哪一块都认。
 * 记在 weixin/sent.json 里，后端重启以后还认得。
 */
import * as fs from "fs";
import * as path from "path";
import { sendText, type WeixinSender } from "./weixinIlink";
import { weixinSentFile } from "./serverPaths";

/** 这条是替别的机器发的：那台叫什么、它的地址（回话往这儿发）。 */
export interface RemoteOrigin {
    label: string;
    /** 那台后端的网页地址（它推过来时给的 `pageUrl`）；没给就是空串（回不去）。 */
    url: string;
    /** 那台那个会话的**会话文件**：回话时那台靠它确认没送错会话。 */
    sessionFile?: string;
}

/** 一条要发到微信的事。 */
export interface WeixinNote {
    /** 哪个会话（界面上显示的那个名字）；这就是那行的“标题”。 */
    name: string;
    /** 会话标识（界面上那一格）。 */
    panelId: string;
    /** 那个会话的会话文件：重启以后 panelId 就换了，这个还认得。 */
    sessionFile?: string;
    /** 那个会话跑在哪个目录：会话关掉之后要把它重新开起来，得在这个目录里起 pi。 */
    cwd?: string;
    /** 一句话摘要（调用方已经截过）。 */
    summary?: string;
    kind: "done" | "ask";
    /** 替别的机器发的：带上它，微信里回一句才知道该转给哪台（见 chatHost.ts 的 handleWeixinInbound）。 */
    remote?: RemoteOrigin;
}

/** 记下"这条是我为了哪个会话发的"：键是服务端 message_id。 */
export interface SentRecord {
    panelId: string;
    sessionFile?: string;
    cwd?: string;
    name: string;
    kind: "done" | "ask";
    at: number;
    /**
     * 替别的机器发的：那台叫什么、它的地址。
     * 有这一条时 panelId 是**那台那边**的会话标识，别在本机找它、也别想在本机重新开起来
     * （会话文件与目录都在那台，见 chatHost.ts 的 handleWeixinInbound）。
     */
    remote?: RemoteOrigin;
}

/** 把那张对账表整个读出来（键是服务端 message_id）；没有 / 读不动就是空的。 */
export function readSentNotes(file: string = weixinSentFile()): Record<string, SentRecord> {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) { return raw as Record<string, SentRecord>; }
    } catch { /* 见上 */ }
    return {};
}

/**
 * 一条收到的微信想接回哪个会话。
 *
 * 引用了某条推送 → 就是那一条对应的会话；
 * 什么也没引用 → 最近一次推过的那个会话（"不引用就接它的下文"）。
 * @returns 没有记录（还没推过任何东西）就是 undefined
 */
export function findRouteForInbound(
    refMessageId: string | undefined,
    file: string = weixinSentFile(),
): SentRecord | undefined {
    const all = readSentNotes(file);
    if (refMessageId && all[refMessageId]) { return all[refMessageId]; }
    if (refMessageId) { return undefined; }   // 引用了但对不上：不瞎猜
    let newest: SentRecord | undefined;
    for (const record of Object.values(all)) {
        if (!newest || (record.at ?? 0) > (newest.at ?? 0)) { newest = record; }
    }
    return newest;
}

/**
 * 一条微信消息最多装多少字。
 *
 * 4000 这个数是跟 pi-weixin-bridge 那个桥一致的（它拿这个数切了很久）：微信单条消息有上限，
 * 拿不准具体数字就照这个已经能通的来。超了就切成几条接着发。
 */
export const WEIXIN_CHUNK_CHARS = 4000;

/** 按字素簇切：👨‍👩‍👧、👋🏽、🇨🇳 这种由好几个码点凑成的一个字，切在中间就成乱码了。 */
const GRAPHEME = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 把一段话切成每条不超过 maxChars 的几条。
 *
 * 优先整行整行地搬（markdown 的列表、代码块都靠行）：一行装不下才按字素簇硬切。
 * 注意代码围栏（```）没有特殊照顾：一个超长的代码块会横跨两条、各自不闭合（跟 pi-weixin-bridge 一样）。
 */
export function chunkWeixinText(text: string, maxChars = WEIXIN_CHUNK_CHARS): string[] {
    if (!text) { return []; }
    if (text.length <= maxChars) { return [text]; }
    const chunks: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length > maxChars && current) {
            chunks.push(current);
            current = line;
        } else {
            current = next;
        }
        // 单行自己就超过一条了：按字素簇硬切（不把字切成两半）
        while (current.length > maxChars) {
            let head = "";
            for (const { segment } of GRAPHEME.segment(current)) {
                if (head.length + segment.length > maxChars) { break; }
                head += segment;
            }
            if (!head) { break; }
            chunks.push(head);
            current = current.slice(head.length);
        }
    }
    if (current) { chunks.push(current); }
    return chunks;
}

/**
 * 排成要发的那几条：头一条是`会话名`空一行接回复原文，后面就是原文接着往下（没有回复文字就只发会话名）。
 * 替别的机器发的，会话名前加一段 `哪台 · `：几台机器一起用时，光看会话名分不出是哪台。
 */
export function buildWeixinMessages(note: WeixinNote): string[] {
    const own = (note.name ?? "").trim() || "会话";
    const label = (note.remote?.label ?? "").trim();
    const title = label ? `${label} · ${own}` : own;
    const body = (note.summary ?? "").trim();
    if (!body) { return [title]; }
    // 头一条要让出标题那一行和空行：每块都按这个窄一点的宽度切，拼起来才不会超
    const chunks = chunkWeixinText(body, WEIXIN_CHUNK_CHARS - title.length - 2);
    return chunks.map((chunk, index) => (index === 0 ? `${title}\n\n${chunk}` : chunk));
}

/** 记多少条：够人回头翻一两天就够了，再多也没人引用到那么早的。 */
const SENT_KEEP = 200;

/**
 * 把这条发出去，顺手记下它对哪个会话；太长的那段按 `WEIXIN_CHUNK_CHARS` 分几条接着发。
 * @param sender 除了令牌与地址，还带着"回信凭据"（微信只认最近一条来信里带的那份，见 weixinInbox.ts）
 * @returns ok 是全都发出去了没有；发不出去只把原因带回去（不抛：提醒失败不该影响会话）
 */
export async function pushWeixinNote(
    note: WeixinNote,
    sender: WeixinSender & { to: string; contextToken?: string },
    file: string = weixinSentFile(),
): Promise<{ ok: boolean; messageId?: string; messageIds: string[]; error?: string }> {
    const messageIds: string[] = [];
    for (const text of buildWeixinMessages(note)) {
        try {
            const sent = await sendText(sender, {
                to: sender.to, text, contextToken: sender.contextToken,
            });
            if (sent.messageId) {
                rememberSent(file, sent.messageId, note);
                messageIds.push(sent.messageId);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, messageId: messageIds[0], messageIds, error: explainSendFailure(message, sender.contextToken) };
        }
    }
    return { ok: true, messageId: messageIds[0], messageIds };
}

/**
 * 发不出去时那句日志多说一句该怎么办。
 *
 * `ret=-2 prepare failed` 是微信那头最常见的拒收（官方那套也是这么解释的）：回信凭据没带、或者过期了。
 * 光看这个数猜不出来，于是就地把该做的事写在后面。
 */
function explainSendFailure(message: string, contextToken?: string): string {
    if (!message.includes("ret=-2")) { return message; }
    return contextToken
        ? `${message}（手上这份回信凭据过期了：在微信里给机器人随便发一句话就来新的）`
        : `${message}（手上还没有回信凭据：先在微信里给机器人发一句话，之后的推送才发得出去）`;
}

/** 追加一条"这条消息是为了哪个会话发的"；文件坏了就重来（别为了留档把提醒本身弄挂）。 */
function rememberSent(file: string, messageId: string, note: WeixinNote): void {
    let all: Record<string, SentRecord> = {};
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) { all = raw as Record<string, SentRecord>; }
    } catch { /* 没有 / 读不动：从空的开始 */ }
    all[messageId] = {
        panelId: note.panelId,
        sessionFile: note.sessionFile,
        cwd: note.cwd,
        name: note.name,
        kind: note.kind,
        at: Date.now(),
        ...(note.remote ? { remote: note.remote } : {}),
    };
    // 只留最近的这些条：按时间排序，把老的丢掉（编号本身不表顺序，得看 at）
    const keys = Object.keys(all);
    if (keys.length > SENT_KEEP) {
        keys.sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0));
        for (const key of keys.slice(0, keys.length - SENT_KEEP)) { delete all[key]; }
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch { /* 记不下来就算了：提醒已经发出去了 */ }
}
