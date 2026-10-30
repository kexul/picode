/**
 * 自动模式（/auto）：每轮跑完，让一个判官看一眼主会话最后说的话，决定要不要再催一句「继续」。
 *
 * 没有目标、没有验收清单：/auto 只是个开关，打开以后不往对话里发任何东西。
 * 之后每一轮正常跑完，插件另起一个短会话当判官（不带工具），把这一轮最后那条回复交给它，
 * 只问一件事：还要不要接着干。说继续就发一句「继续」；说不继续就把这个开关关掉。
 *
 * 全是纯函数：认命令、拼判官那一轮的提示、从判官回复里认出结论、算那颗图标上指着的说明。
 * 存盘在 autoFiles.ts；提示词的原文在 promptText.ts（那边可被 config.json 覆盖）。
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

/** 打进来的命令，也是输入框底下那颗转圈圈图标按下时用的（见 chatControllerBase.onAutoCommand）。 */
export type AutoCommand =
    /** 打开（已经开着就是看状态） */
    | { kind: "on" }
    /** 只看状态 */
    | { kind: "show" }
    /** 关掉，不再追踪 */
    | { kind: "off" }
    /** 打成了 `/auto 别的什么`：这命令不接东西 */
    | { kind: "hint" };

/**
 * 这一句是不是 /auto。
 *
 * 只有 `/auto` 一个词：它不接任何东西（没有目标可写）。后面跟着别的字就回一句提示，
 * 免得那一串字悄悄被吞掉。
 */
export function parseAutoCommand(text: string): AutoCommand | null {
    if (typeof text !== "string") { return null; }
    const m = text.match(/^\/auto(?:[ \t]+([\s\S]*))?$/i);
    if (!m) { return null; }
    return (m[1] ?? "").trim() ? { kind: "hint" } : { kind: "on" };
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
 * 输入框底下那颗转圈圈图标指上去说什么（纯函数；界面直接用它当 title）。
 *
 * @param judging 这一轮正有判官在看（主会话已经跑完了）：要写出来，不然看着像卡住了。
 */
export function autoIndicatorTitle(auto: AutoState, judging: boolean): string {
    return "自动模式"
        + (auto.rounds > 0 ? ` · 第 ${auto.rounds} 轮` : "")
        + (judging ? " · 判官正在看" : "")
        + "（点一下停止）";
}
