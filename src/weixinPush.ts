/**
 * weixinPush —— 会话有事时往微信里发一条。
 *
 * 发出去就一行：`会话名：回复的开头几句`（没有回复文字就只写会话名）。
 * 不写是哪台机器、不写"跑完了一轮"、也不附地址：微信里看到的就是"哪个会话说了什么"，
 * 想知道是哪台、想接着聊，引用这条消息回一句就是了（那才是这件事真正的入口）。
 *
 * 为什么要发而不是只弹面板：面板只在跑后端的那台 Windows 上有，人可能在别的屋里、在外面。
 * 微信这条也不看"人是不是正坐在输入框前面"（见 chatHost.ts 的 trayNote）：那是给不在电脑前准备的。
 *
 * 发出去的每条都记下服务端给的 message_id：以后"在微信里引用这条消息回一句"要知道接哪个会话
 * （那个 id 是唯一能把两边对上的东西）。记在 weixin/sent.json 里，后端重启以后还认得。
 */
import * as fs from "fs";
import * as path from "path";
import { sendText, type WeixinSender } from "./weixinIlink";
import { weixinSentFile } from "./serverPaths";

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
}

/** 记下"这条是我为了哪个会话发的"：键是服务端 message_id。 */
export interface SentRecord {
    panelId: string;
    sessionFile?: string;
    cwd?: string;
    name: string;
    kind: "done" | "ask";
    at: number;
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

/** 记多少条：够人回头翻一两天就够了，再多也没人引用到那么早的。 */
const SENT_KEEP = 200;

/** 排成一条微信消息该长的样子：`会话名：摘要`（没有摘要就只剩会话名）。 */
export function formatWeixinNote(note: WeixinNote): string {
    const name = (note.name ?? "").trim() || "会话";
    const summary = (note.summary ?? "").trim();
    return summary ? `${name}：${summary}` : name;
}

/**
 * 把这条发出去，顺手记下它对哪个会话。
 * @returns ok 是发出去了没有；发不出去只把原因带回去（不抛：提醒失败不该影响会话）
 */
export async function pushWeixinNote(
    note: WeixinNote,
    sender: WeixinSender & { to: string },
    file: string = weixinSentFile(),
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    try {
        const sent = await sendText(sender, {
            to: sender.to,
            text: formatWeixinNote(note),
        });
        if (sent.messageId) { rememberSent(file, sent.messageId, note); }
        return { ok: true, messageId: sent.messageId };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
