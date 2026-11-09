/**
 * 一个会话此刻处在哪个阶段：全应用只此一处算。
 *
 * 为什么单拎出来：这个事实原来散在后端几个字段和界面五处判断里（模型胶囊那颗 `data-st`、
 * 输入框顶边那颗小图形、会话格上的小点、消息流末尾那颗胶囊、关会话要不要问第二遍），
 * 每处各挑几个字段自己拼，于是同一时刻能得出不同答案 —— 压缩上下文时界面当它闲着
 * （`streaming` 是 false，可它明明忙）、模型在等你答选择题时除了右下角那张卡片别处都看不出来。
 *
 * 现在：后端算一次，挂在 `sessionList` 与 `phaseChanged` 上；界面只存这一个值，不再自己拼。
 * 加一个阶段只改这一个函数（漏写一支，`switch` 的穷举检查会报错）。
 *
 * 为什么是两个轴、不是一个值：`在跑工具` 和 `在等你答一句` 会同时成立
 * （`ask_choice` 那个工具就一直在跑，直到你答完）。合成一个值，两者必有一个要丢。
 *   - `phase`：进程在干什么（下面那张表）；
 *   - `attention`：要不要人管（没填 / 等你答 / 跑完了你还没看）。
 */
import type { RuntimeActivity } from "./runtimeTypes";

/**
 * 进程在干什么。取值是有限的，列表就是全部：
 *
 *   none       没有会话（界面上那份：刚打开页面，还没挑工作区）
 *   loading    正在加载会话 / 分叉（pi 冷启动、切会话那几秒）
 *   starting   pi 进程还没起来 / 没就绪
 *   nomodel    没配模型（点胶囊去选）
 *   idle       闲着
 *   compacting 正在压缩上下文（这时 streaming 是 false，不单列就看不出来）
 *   waiting    这一轮开始了、还没吐字（等第一个字 / 想完等正文 / 等工具参数）
 *   writing    正文正在流
 *   thinking   在想
 *   tool       工具在跑
 */
export type SessionPhase =
    | "none"
    | "loading"
    | "starting"
    | "nomodel"
    | "idle"
    | "compacting"
    | "waiting"
    | "writing"
    | "thinking"
    | "tool";

/**
 * 要不要人管。
 *
 *   ""        不用人管（在跑、或者闲着都算）
 *   answer    有一道题在等你答（问话卡片挂着，这一轮就停在那儿）
 *   done      这一轮跑完了，你还没看过（右下角那张提醒卡片还在）
 */
export type SessionAttention = "" | "answer" | "done";

export interface SessionPhaseInput {
    /** 有没有会话。界面那份“一个会话都没有”传 false。 */
    hasSession: boolean;
    piReady: boolean;
    loading: boolean;
    /** 配了模型没有。 */
    hasModel: boolean;
    compacting: boolean;
    streaming: boolean;
    activity: RuntimeActivity;
    /** 这一轮里正文正在流（模型刚吐过字、这条 assistant 消息还没完）。 */
    writing: boolean;
}

/**
 * 算阶段。判定的先后就是这张表的语义，顺序有讲究：
 *
 *   1. 没会话 / 加载中 / 进程没起来 / 没模型 —— 这四样是“还不能干活”，压过一切；
 *   2. 压缩中 —— 它发生在两轮之间（streaming 是 false），不放在“闲着”前面就永远看不到；
 *   3. 没在跑就是闲着；
 *   4. 在跑：想 / 工具在跑都压过“在写字”（后端报的两个更准，界面以前也是这么分的）；
 *      都没有、但正文在流就是写；再不是就是还在等第一个字。
 */
export function sessionPhase(input: SessionPhaseInput): SessionPhase {
    if (!input.hasSession) { return "none"; }
    if (input.loading) { return "loading"; }
    if (!input.piReady) { return "starting"; }
    if (!input.hasModel) { return "nomodel"; }
    if (input.compacting) { return "compacting"; }
    if (!input.streaming) { return "idle"; }
    if (input.activity === "thinking") { return "thinking"; }
    if (input.activity === "tool") { return "tool"; }
    if (input.writing) { return "writing"; }
    return "waiting";
}

/**
 * 这个阶段算不算“没干完”（会话格那颗点在呼吸、关会话要问第二遍、末尾那颗写「卡住了」）。
 *
 * 有意的两处与以前不一样：
 *   - `loading` 算忙（以前顶条那颗点算，关会话却不问）；
 *   - `compacting` 算忙（以前两处都不算，看着像闲着）。
 */
export function isBusyPhase(phase: SessionPhase): boolean {
    switch (phase) {
        case "loading":
        case "compacting":
        case "waiting":
        case "writing":
        case "thinking":
        case "tool":
            return true;
        case "none":
        case "starting":
        case "nomodel":
        case "idle":
            return false;
    }
}

/**
 * 给悬浮提示用的一句短话（`idle` / 在跑那几档由界面自己写模型名与用量，
 * 这里只给“还没就绪 / 特殊忙法”的说明）。
 */
export function phaseNote(phase: SessionPhase): string {
    switch (phase) {
        case "none": return "没有会话";
        case "loading": return "加载中…";
        case "starting": return "等待 pi 启动…";
        case "nomodel": return "未配置模型（点击选择）";
        case "compacting": return "正在压缩上下文…";
        case "waiting": return "等模型开口…";
        case "writing": return "正在写…";
        case "thinking": return "在想…";
        case "tool": return "工具在跑…";
        case "idle": return "";
    }
}
