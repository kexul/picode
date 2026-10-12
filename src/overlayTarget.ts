/**
 * 浮层该发给哪个界面。
 *
 * 本机界面（VSCode 里就是插件里那块对话面板）与浏览器页面（手机 + 电脑，可以同时开着）
 * 接在同一份会话上：消息、会话这些共用状态两边都发；浮层（历史会话列表、模型选择、
 * 确认框这类"当时的一次性界面"）只发给一个界面——谁点的就给谁，插件自己发起
 * （例如 pi 在对话中间问事）就给"人最近在动的那一个"。
 *
 * 这里只管挑人，不碰消息通道，方便直接测。
 */

/** 某个页面最近一次"人在里面动过"的时刻。 */
export interface OverlayPageAction {
    id: string;
    at: number;
}

/**
 * 挑一个界面来收浮层。
 *
 * 规则（按顺序）：
 * 1. 某个页面最近有人在动（比本机界面的动作还新鲜）→ 那个页面；
 * 2. 否则本机界面开着 → 本机界面（那是这块工作区的"家"，没人动过时弹它最稳）；
 * 3. 本机界面不在（没打开过、或已经关掉）→ 最近连着的那个页面；
 * 4. 一个界面都没有 → 空串（调用方按"没地方弹"处理）。
 *
 * @param localId 本机界面在这个宿主里的标识（VSCode 里就是插件里那块对话面板）
 * @param localActiveAt 人最后一次在本机界面里做动作的时刻（从没动过传 0）
 * @param localAvailable 本机界面这个界面现在在不在
 * @param pageAction 人最后一次在某个浏览器页面里做动作的时刻
 * @param fallbackPageId 最近连着的那个页面（没有就传 undefined）
 */
export function pickOverlayClient(
    localId: string,
    localActiveAt: number,
    localAvailable: boolean,
    pageAction: OverlayPageAction | undefined,
    fallbackPageId: string | undefined,
): string {
    if (pageAction && pageAction.at >= localActiveAt) { return pageAction.id; }
    if (localAvailable) { return localId; }
    return fallbackPageId ?? "";
}
