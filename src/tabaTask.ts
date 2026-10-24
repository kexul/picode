/**
 * 派子会话（taba）：子会话的开场怎么准备。
 *
 * 子会话一律是全新会话：会话文件由 pi 自己新建，插件不预写、不带父会话之前的对话
 * （只把父会话记录文件的路径告诉它，要看背景自己读，见 buildParentContextText）。
 * 所以这里只剩一件事：第一条发给子会话的消息怎么写（任务 + 派活的会话 + 收尾要求）。
 *
 * 全是纯函数。
 */

/**
 * 子会话的记号：派活那套文字里一定有这一行，而它只会出现在子会话的第一条用户消息里。
 * 历史会话列表拿它把子会话认出来、不显示（见 sessionStore.scanSessionInfo）。
 */
export const TABA_CLOSING_MARK = "【收尾要求】";

/** 收尾要求：子会话跑完这一轮，最后一条回复会被自动交回派活的那个会话。 */
export const TABA_CLOSING_INSTRUCTION = [
    TABA_CLOSING_MARK,
    "",
    "你跑完这一轮以后，你的最后一条回复会被自动送回派活给你的那个会话（然后这个会话一般就被自动关掉了），所以最后一条回复要写成一份完整交代：",
    "结论是什么、动了哪些文件、还有哪些没做完或者需要对方拿主意的地方。中间过程不用重复一遍。",
    "任务说明里没交代清楚的地方，按最合理的做法处理，并在最后一条回复里说明你做了什么判断。",
    "这一轮还在跑的时候，用户可能直接进这个会话跟你说话，那时按用户说的做。",
].join("\n");

/**
 * 派活那个会话的记录文件：只给路径和「要看自己读」的提醒，不把对话贴过来
 * （跟 # 引用一个做法，见 chatControllerBase.buildChatReference）。
 * 拿不到路径时这一段整个不出现。
 */
export function buildParentContextText(p: { parentSessionFile: string; parentSessionName?: string }): string {
    const who = p.parentSessionName ? `「${p.parentSessionName}」` : "派活给你的那个会话";
    return [
        "【派活给你的会话】",
        "",
        `派你来的${who}，它的会话记录文件在这里：`,
        p.parentSessionFile,
        "",
        "任务说明里没交代、你又确实需要的背景，可以去读这个文件，不必现在就读："
        + "一行一条记录（用户的话、AI 的话、每次工具调用与返回都在里面），而且它现在可能还在往下写。"
        + "文件可能很大，别一次整个读进来：用 read 的 offset / limit，或者 bash 的 tail / grep 挑重点。",
    ].join("\n");
}

/** 发给子会话的第一条消息：任务原文 + 派活那个会话的记录文件 + 收尾要求。 */
export function buildTaskText(p: { task: string; parentSessionFile?: string; parentSessionName?: string }): string {
    const parts = [`【任务】\n\n${p.task.trim()}`];
    if (p.parentSessionFile) {
        parts.push(buildParentContextText({ parentSessionFile: p.parentSessionFile, parentSessionName: p.parentSessionName }));
    }
    parts.push(TABA_CLOSING_INSTRUCTION);
    return parts.join("\n\n---\n\n");
}
