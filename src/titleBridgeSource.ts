/**
 * 自动起标题：塞进 pi 进程里的那个扩展文件的源码。
 *
 * 插件把这份源码写到 ~/.pi/pichat/title-bridge-<插件版本>.ts，
 * **只有主会话**的 pi 进程启动时用 `-e` 加载它（子会话、判官不带：它们的名字由派活那边给）。
 *
 * 干的事：在一轮对话跑完（agent_settled）时看这个会话走到第几轮，到了约定那几个节点
 * （第 1 / 10 / 30 / 70 轮）就让当前模型起一次短标题，写进会话名（pi.setSessionName）。
 * 越往后越稀：会话开头先给个名字，之后每次大跨一步再按现在在做的事重起一次。
 * 插件那边收到 pi 的 session_info_changed 事件，界面上显示的会话名就跟着换
 * （顶条、会话列表、历史都用它，见 chatControllerBase.baseSessionDisplayName）。
 *
 * 用户自己 /name 起的名字永远是老大：认出来这个名字不是自己起的，就一次都不动它。
 * 靠的是往会话里记一条记号（appendEntry，跟着会话文件存，进程重启还认）。
 *
 * 跟另外三套桥的差别：它不往 stderr 写暗号，也不要插件配合 —— 标题走 pi 自己的会话名。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留（比如正则里的 "\s" 不能被外层先转义）。
 * 里面不要出现 "${"：外层是模板字符串，那样会被当插值。
 *
 * 这是一份函数而不是常量：起标题那段的说明人能改（config.json 的 prompts.title），
 * 写文件时把当前那份拼进去。
 */
import { promptText, type PromptOverrides } from "./promptText";

export function titleBridgeSource(over?: PromptOverrides): string {
    return String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：到了约定的轮数（第 1 / 10 / 30 / 70 轮）跑完，让当前模型给这个会话起个短标题，
 * 写进会话名。每次只发一个短请求，不写进对话记录（对话里看不到它）。
 */
import { randomUUID } from "node:crypto";

const SYSTEM_PROMPT = ${JSON.stringify(promptText(over, "title"))};

/**
 * 在哪几条用户消息之后起一次标题：第 1 轮先给个名字，之后 10、30、70 轮各按现在在做的事重起一次。
 * 判断用的是会话里用户消息的条数（不是本进程数了几次），所以插件重启、切回来接着聊都不会数错。
 */
const TITLE_ROUNDS = [1, 10, 30, 70];

/** 起标题时带上最近几轮对话。 */
const RECENT_TURNS = 3;

/** 自己起的标题记在会话里的哪一条（见 pi.appendEntry；重启以后靠它认出「这名字是我起的」）。 */
const OWN_TITLE_ENTRY = "pichat.title";

/** 起标题这一次最多花多少输出 token（思考也算在里面，见 withoutThinking 的说明）。 */
const TITLE_MAX_TOKENS = 512;

function textOf(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((part) => (part && part.type === "text" && typeof part.text === "string") ? part.text : "")
        .join("");
}

function clip(text, limit) {
    return text.length > limit ? text.slice(0, limit) : text;
}

function cleanTitle(raw) {
    const line = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (!line) {
        return undefined;
    }
    const title = line
        .replace(/^\s*(?:title|标题)\s*[:：]\s*/i, "")
        .replace(/^#+\s*/, "")
        .replace(/^[“"'\u0060]+|[”"'\u0060]+$/g, "")
        .replace(/\s+/g, " ")
        .replace(/[。.!！?？]+$/g, "")
        .trim()
        .slice(0, 40);
    return title.length >= 2 ? title : undefined;
}

/**
 * 这个会话走到第几轮 = 会话里用户消息有几条。
 * 跟下面取内容那个分开数：一条字都没答出来的一轮也算走过了一轮，轮数不能因此少算。
 */
function roundCount(entries) {
    let count = 0;
    for (const entry of entries) {
        if (entry && entry.type === "message" && entry.message && entry.message.role === "user") {
            count++;
        }
    }
    return count;
}

/** 把会话里的一问一答收成轮次：每条规定有用户说的话，助手那段可能还空着。 */
function conversationTurns(entries) {
    const list = [];
    let current;
    for (const entry of entries) {
        if (!entry || entry.type !== "message" || !entry.message) {
            continue;
        }
        const role = entry.message.role;
        if (role === "user") {
            current = { user: textOf(entry.message.content).trim(), assistant: "" };
            list.push(current);
        } else if (role === "assistant" && current) {
            const text = textOf(entry.message.content).trim();
            if (text) {
                current.assistant = current.assistant ? current.assistant + "\n" + text : text;
            }
        }
    }
    return list;
}

/** 上一次自己起的标题和当时到第几轮（没起过就是 undefined）。 */
function ownTitle(entries) {
    let last;
    for (const entry of entries) {
        if (!entry || entry.type !== "custom" || entry.customType !== OWN_TITLE_ENTRY) {
            continue;
        }
        const data = entry.data;
        if (data && typeof data.title === "string" && typeof data.round === "number") {
            last = data;
        }
    }
    return last;
}

/** 到了哪个该起标题的节点（没到就是 0；轮数一下子跨过好几个节点时取最大的那个）。 */
function dueRound(rounds) {
    let due = 0;
    for (const node of TITLE_ROUNDS) {
        if (node <= rounds) {
            due = node;
        }
    }
    return due;
}

/**
 * 给模型看的那段：第一条用户消息（定基调）+ 最近几轮（现在在干什么）。
 * 第一轮时这两样是同一轮，不说两遍。
 */
function contextText(firstUser, list) {
    const lines = [];
    lines.push("--- First user message ---");
    lines.push(clip(firstUser, 1200));
    const first = Math.max(1, list.length - RECENT_TURNS);
    if (first < list.length) {
        lines.push("--- Recent turns ---");
        for (const turn of list.slice(first)) {
            lines.push("[user] " + clip(turn.user, 600));
            lines.push("[assistant] " + clip(turn.assistant, 900));
        }
    }
    lines.push("--- End conversation data ---");
    return lines.join("\n");
}

/**
 * 起标题用的模型副本：把思考关掉。
 *
 * 为什么必须动它：thinkingLevelMap.off 配成 null 的模型（deepseek-flash、glm-5.3-flash 就是这样），
 * 框架会整个不带 reasoning 参数，而模型默认照样思考 —— 输出上限小的时候，思考把额度吃光，
 * 正文一个字都没有，标题就悄悄没了（不报错、不重试）。
 * 把 off 改成 "none" 之后，框架会明确发 reasoning: { effort: "none" }：
 *   - 支持关思考的模型（deepseek-flash）真的会关掉，快很多；
 *   - 不支持、照旧思考的模型（glm-5.3-flash）请求照样收，靠 TITLE_MAX_TOKENS 的余量照样出标题。
 * 其它接口（openai-completions 等）不动：那边 reasoning 参数怎么写没验过，不动最稳。
 */
function withoutThinking(model) {
    const thinkingLevelMap = model.thinkingLevelMap;
    if (model.api !== "openai-responses" || !thinkingLevelMap || thinkingLevelMap.off !== null) {
        return model;
    }
    return { ...model, thinkingLevelMap: { ...thinkingLevelMap, off: "none" } };
}

export default function titleBridge(pi) {
    let generating = false;

    pi.on("agent_settled", async (_event, ctx) => {
        if (generating || !ctx.model || !ctx.isIdle()) {
            return;
        }
        const branch = ctx.sessionManager.getBranch();
        const rounds = roundCount(branch);
        // 到了节点才起名字；还没到下一个节点（或者上一个节点已经起过了）就什么都不做
        const due = dueRound(rounds);
        const own = ownTitle(branch);
        if (!due || due <= (own ? own.round : 0)) {
            return;
        }
        // 现在的名字不是自己起的（用户 /name 改过、或者别处设的）：一直不动它
        const before = pi.getSessionName();
        if (before && before !== (own ? own.title : undefined)) {
            return;
        }
        // 问什么：第一轮 + 最近几轮，只要问得出话、答得出字的那几轮
        const all = conversationTurns(branch);
        const firstUser = (all.find((turn) => turn.user) || {}).user || "";
        if (!firstUser) {
            return;
        }
        const list = all.filter((turn) => turn.user && turn.assistant);
        if (!list.length) {
            return;
        }

        generating = true;
        try {
            const response = await ctx.modelRegistry.complete(
                withoutThinking(ctx.model),
                {
                    systemPrompt: SYSTEM_PROMPT,
                    messages: [{
                        role: "user",
                        content: [{ type: "text", text: contextText(firstUser, list) }],
                        timestamp: Date.now(),
                    }],
                },
                {
                    maxTokens: TITLE_MAX_TOKENS,
                    cacheRetention: "none",
                    sessionId: randomUUID(),
                },
            );
            const title = cleanTitle(
                response.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n"),
            );
            // 这个短请求发出去以后，用户可能自己 /name 改过名了：名字变了就不覆盖。
            if (title && pi.getSessionName() === before) {
                pi.setSessionName(title);
                // 记一笔：下次靠它认出这个名字是自己起的
                pi.appendEntry(OWN_TITLE_ENTRY, { title, round: due });
            }
        } catch (error) {
            // 起标题是顺手的事，绝不能因此打断用户正在用的会话。
            console.warn("[title-bridge] title generation failed:", error);
        } finally {
            generating = false;
        }
    });
}
`;
}
