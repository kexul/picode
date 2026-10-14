/**
 * 推送通道（后端 ⇄ 页面）上那几个时间：写在一处，谁也别再抄一份。
 *
 * 谁用：
 *   - webChatServer.ts（后端）：按 HEARTBEAT_MS 写心跳、按 PAGE_STALE_MS 收掉死连接；
 *   - backendClient.ts（插件那侧客户端）：用 TICK_TIMEOUT_MS 判连接死没死、按 PING_MS 报活；
 *   - 浏览器页面里的 browserBridge.js 是另一个运行时，读不了这份文件 —— 所以后端在握手
 *     （hello）时把这三个数一起告诉它（见 webChatServer 发 hello 那行），页面里不留规则。
 *
 * 改这里的数，后端与两个客户端一起变；网页那一份靠握手跟上，界面文件不用动。
 */
/** 心跳间隔：后端每这么久给每条推送连接写一个 tick（顺带巡检一遍死连接）。 */
export const HEARTBEAT_MS = 25_000;
/** 连着丢这么多个心跳还没见到下一个，客户端就认定这条连接已经死了。 */
export const HEARTBEAT_MISSES = 3;
/** 客户端这么久没收到心跳就重连（手机 / 笔记本睡过去再醒来时常见）。 */
export const TICK_TIMEOUT_MS = HEARTBEAT_MS * HEARTBEAT_MISSES;
/**
 * 页面多久没动静（报活或发消息）就收掉它那条连接。
 * 手机退到后台后定时器被冻住，报活自然停了：那条连接多半已经死了，占着只会白攒消息。
 * 页面回到前台会自己重连，报上自己处理到第几条消息，后端把漏掉的补发给它；
 * 补不上的才整屏重画。VS Code 窗口也一样。
 */
export const PAGE_STALE_MS = 90_000;
/** 客户端报活的间隔：判死上限的三分之一，正常情况绝不会被误判。 */
export const PING_MS = PAGE_STALE_MS / 3;
