/**
 * 派子会话（taba）：子会话的开场怎么准备。
 *
 * 子会话一律是全新会话：会话文件由 pi 自己新建，插件不预写、不带父会话之前的对话
 * （只把父会话记录文件的路径告诉它，要看背景自己读，见 buildParentContextText）。
 * 所以这里只剩一件事：第一条发给子会话的消息怎么写（任务 + 派活的会话 + 收尾要求）。
 *
 * 全是纯函数；三段文字本身在 promptText.ts（可被 config.json 的 prompts 一节覆盖）。
 */
import { promptText, type PromptOverrides } from "./promptText";

/**
 * 子会话的记号：派活那套文字里一定有这一行，而它只会出现在子会话的第一条用户消息里。
 * 历史会话列表拿它把子会话认出来、不显示（见 sessionStore.scanSessionInfo）。
 *
 * 提示词可以被人改（prompts.tabaClosing）：改掉「【收尾要求】」这一行的话，
 * 新文件得靠 child-sessions 那份清单认（见 childSessions），老文件就认不出来了。
 */
export const TABA_CLOSING_MARK = "【收尾要求】";

/**
 * 派活那个会话的记录文件：只给路径和「要看自己读」的提醒，不把对话贴过来
 * （跟 # 引用一个做法，见 chatControllerBase.buildChatReference）。
 * 拿不到路径时这一段整个不出现。
 */
export function buildParentContextText(p: {
    parentSessionFile: string;
    parentSessionName?: string;
}, over?: PromptOverrides): string {
    return promptText(over, "tabaParentContext", {
        // 「派活的会话名」外面包一层「」：原文里是「派你来的「名字」，它的…」
        会话: p.parentSessionName ? `「${p.parentSessionName}」` : "派活给你的那个会话",
        会话文件: p.parentSessionFile,
    });
}

/**
 * 发给子会话的第一条消息：任务原文 + 派活那个会话的记录文件 + 收尾要求。
 * 三段文字都在 promptText.ts（可被 config.json 覆盖）。
 */
export function buildTaskText(p: {
    task: string;
    parentSessionFile?: string;
    parentSessionName?: string;
}, over?: PromptOverrides): string {
    const parts = [`【任务】\n\n${p.task.trim()}`];
    if (p.parentSessionFile) {
        parts.push(buildParentContextText({
            parentSessionFile: p.parentSessionFile,
            parentSessionName: p.parentSessionName,
        }, over));
    }
    parts.push(promptText(over, "tabaClosing"));
    return parts.join("\n\n---\n\n");
}
