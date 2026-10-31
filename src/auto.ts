/**
 * 自动模式：每轮跑完，让一个判官看一眼主会话最后说的话，决定要不要再催一句「继续」。
 *
 * 开关就是输入框右下角那颗圆圈的按钮：点一下开始，再点一下停；开了不往对话里发任何东西。
 * 之后每一轮正常跑完，插件另起一个短会话当判官（不带工具），把这一轮最后那条回复交给它，
 * 只问一件事：还要不要接着干。说继续就发一句「继续」；说不继续就把这个开关关掉。
 *
 * 全是纯函数：拼判官那一轮的提示、从判官回复里认出结论、算那颗按钮上指着的说明、
 * 自动模式下替人答选择题时选哪几项。存盘在 autoFiles.ts；提示词的原文在 promptText.ts（那边可被 config.json 覆盖）。
 */
import { promptText, type PromptOverrides } from "./promptText";

export interface AutoState {
    /** 叫过几次判官（这个开关开着以来的轮数）。 */
    rounds: number;
    /** 最近一句：判官说了什么（停的时候写进系统提示）。 */
    note?: string;
    /** 最近一次改动的时刻（写盘、比对用）。 */
    updatedAt: number;
}

/** 那颗按钮按下时用的（见 chatControllerBase.onAutoCommand），另外 `silent` 是打 /auto 那种字样用的。 */
export type AutoCommand =
    /** 打开（已经开着就是看状态） */
    | { kind: "on" }
    /** 只看状态 */
    | { kind: "show" }
    /** 关掉，不再追踪 */
    | { kind: "off" }
    /** 打的是 `/auto` 这几个字：吞掉（不发给模型、也不回话） */
    | { kind: "silent" };

/**
 * 这一句是不是 /auto。
 *
 * 开关现在是那颗按钮（右下角），所以 `/auto` 这几个字只是不让它落到模型眼里：
 * 吞掉就算了，不回话。
 */
export function parseAutoCommand(text: string): AutoCommand | null {
    if (typeof text !== "string") { return null; }
    return /^\/auto(?:[ \t]|$)/i.test(text) ? { kind: "silent" } : null;
}

/** 一路都答不出个所以然时最多连多少轮：防一个永远说"还差一点"的会话把钱烧光。 */
export const MAX_AUTO_ROUNDS = 30;

/** 判官说接着干时，发给主会话的那句话。 */
export const AUTO_CONTINUE_TEXT = "继续";

/** 判官那一轮的任务说明（原文见 promptText.ts 的 autoJudge，人可以改）。 */
export function buildAutoJudgePrompt(p: { round: number; said: string }, over?: PromptOverrides): string {
    return promptText(over, "autoJudge", {
        轮次: String(p.round),
        最后一条回复: (p.said || "").trim() || "（这一轮它没留下回复）",
    });
}

/** 判官回的那一句话读出来是什么意思。 */
export interface AutoVerdict {
    /** 还要接着干。 */
    go: boolean;
    /** 判官说的一句话（写进系统提示）；没有就是空串。 */
    note: string;
}

/** 话里像"不用再干"的记号（要先认这些：它们里头常常还带着「继续」两个字）。 */
const STOP_WORDS = /不继续|不用继续|不需要继续|不必继续|已经完成|已完成|做完了|搞定了|办完了|结束|停下|停止|done|finished|stop/i;

/** 话里像"接着干"的记号。 */
const GO_WORDS = /继续|接着|还没|没做完|没完成|continue|go on/i;

/**
 * 从判官的最后一条回复里读结论。
 *
 * 认不出来就当继续：这是个无情的继续机器，卡住人的成本比多跑一轮高。
 */
export function parseAutoVerdict(reply: string): AutoVerdict {
    const text = (reply || "").trim();
    if (!text) { return { go: true, note: "" }; }
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? "";
    const note = text.length > 2000 ? text.slice(0, 2000) : text;
    if (STOP_WORDS.test(firstLine)) { return { go: false, note }; }
    if (GO_WORDS.test(firstLine)) { return { go: true, note }; }
    // 第一行看不出来就看整段（判官爱先写一句"我看了这一轮"再说结论）
    if (STOP_WORDS.test(text)) { return { go: false, note }; }
    return { go: true, note };
}

/**
 * 自动模式开着的时候替人答一张选择题（`ask_choice`）：选它自己推荐的那几项；
 * 一个都没推荐就选第一项。单选只留一项（推荐了多项就取最靠前的那一项）。
 *
 * 有这个函数是因为「自动模式下问问题就当继续」：没人来点那张卡片，模型会一直等着，
 * 所以卡片根本不发出去，直接按它推荐的那一项把答案写回去。
 */
export function autoAskPicks(req: { options?: unknown; multi?: unknown; recommended?: unknown }): string[] {
    const options = (Array.isArray(req.options) ? req.options : [])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (options.length === 0) { return []; }
    const want = new Set<number>();
    for (const n of Array.isArray(req.recommended) ? req.recommended : []) {
        const i = Math.trunc(Number(n));
        if (Number.isFinite(i) && i >= 1 && i <= options.length) { want.add(i - 1); }
    }
    if (want.size === 0) { want.add(0); }
    const picked = Array.from(want).sort((a, b) => a - b).map((i) => options[i]);
    return req.multi === true ? picked : picked.slice(0, 1);
}

/**
 * 输入框右下角那颗按钮指上去说什么（纯函数；界面直接用它当 title）。
 *
 * @param judging 这一轮正有判官在看（主会话已经跑完了）：要写出来，不然看着像卡住了。
 */
export function autoIndicatorTitle(auto: AutoState, judging: boolean): string {
    return "自动模式"
        + (auto.rounds > 0 ? ` · 第 ${auto.rounds} 轮` : "")
        + (judging ? " · 判官正在看" : "")
        + "（点一下停止）";
}
