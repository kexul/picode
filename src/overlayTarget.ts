/**
 * 浮层该发给哪个界面。
 *
 * 浏览器页面（手机 + 电脑，可以同时开着）接在同一份会话上：消息、会话这些共用状态每块屏都发；
 * 浮层（历史会话列表、模型选择、确认框这类"当时的一次性界面"）只发给一块屏——谁点的就给谁，
 * 插件自己发起（例如 pi 在对话中间问事）就给"人最近在动的那一块"。
 *
 * 这里只管挑人，不碰消息通道，方便直接测。
 */

/** 某个页面最近一次"人在里面动过"的时刻。 */
export interface OverlayPageAction {
    id: string;
    at: number;
}

/**
 * 挑一块屏来收浮层。
 *
 * 规则（按顺序）：
 * 1. 某个页面最近有人在动 → 那个页面；
 * 2. 没有动作记录 → 最近连着的那个页面；
 * 3. 一个页面都没有 → 空串（调用方按"没地方弹"处理）。
 */
export function pickOverlayClient(
    pageAction: OverlayPageAction | undefined,
    fallbackPageId: string | undefined,
): string {
    if (pageAction) { return pageAction.id; }
    return fallbackPageId ?? "";
}
