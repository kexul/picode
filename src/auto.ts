/**
 * 自动模式：每轮正常跑完，直接给主会话发一句「继续」。
 *
 * 开关就是输入框右下角那颗小开关：点一下拨开，再点一下停；开了不往对话里发任何东西。
 * 之后每一轮正常跑完就发一句「继续」。派出去的子会话还在跑时改发一句
 * 「现在有子任务在跑着，你这边也别闲着」（主会话别停着等）；后台命令还在跑时先不发，
 * 等命令结果交回、那一轮跑完再发 —— 两边一起催会撞在一处。
 * 不记轮数、不判断，停下只有人再点一下那颗开关。
 *
 * 另外是纯函数：认出 /auto 那几个字、自动模式下替人答选择题时选哪几项。
 * 存盘在 autoFiles.ts。
 */

/** 开关本身：只要这个会话开着就有一份。 */
export interface AutoState {
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

/** 一轮跑完时，发给主会话的那句话。 */
export const AUTO_CONTINUE_TEXT = "继续";

/**
 * 派出去的子会话还在跑、主会话这一轮先跑完时，发给主会话的那句话。
 *
 * 这时候发「继续」会跟子会话的结果撞在一处，也说不清在等什么：直接告诉它别停着。
 */
export const AUTO_CHILDREN_RUNNING_TEXT = "现在有子任务在跑着，你这边也别闲着";

/**
 * 自动模式开着的时候替人答一张选择题（`ask_user`）：选它自己推荐的那几项；
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
