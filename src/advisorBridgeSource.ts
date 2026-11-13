/**
 * 问顾问（ask_advisor）：塞进 pi 进程里的那个扩展文件的源码。
 *
 * 插件启动时把下面这份源码写到 <pichatDir>/advisor-bridge-<插件版本>.ts，
 * 每个会话的 pi 进程启动时都用 `-e <那个文件>` 加载它。
 * 注意不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 用户在终端里手跑的 pi 也会被塞上这个工具 —— 它只有插件的会话里才有意义。
 *
 * 作用：给模型一个工具 ask_advisor。干活的那个模型卡住时调它，这里把当前对话
 * （已经压过上下文的那份）原样发给一个更强的模型，让那个模型只回一段计划；
 * 回话就是这个工具的结果，执行器接着往下干。顾问不调用工具、不碰文件、
 * 也不生成给人看的话，只给执行器提建议。
 *
 * 顾问模型从环境变量 PICHAT_ADVISOR_MODEL 读（provider/model，见设置里那行「顾问模型」）：
 * 没填就不注册这个工具 —— 模型那边压根看不到它。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留（比如 "\n" 不能被外层先转义成真换行）。
 */
import { promptText, type PromptOverrides } from "./promptText";

export function advisorBridgeSource(over?: PromptOverrides): string {
    return String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：给模型一个工具 ask_advisor（问顾问）。
 * 干活的那个模型卡住时调它，这里把当前对话（已经压过上下文的那份）发给一个更强的模型，
 * 让那个模型只回一段计划；回话就是这个工具的结果，执行器接着往下干。
 *
 * 顾问模型从环境变量 PICHAT_ADVISOR_MODEL 读（provider/model）：没填就不注册这个工具。
 * 顾问不调用工具、不碰文件、也不生成给人看的话：它只给执行器提建议。
 */
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/** 顾问模型：provider/model。没写 provider 的，就在执行器那个 provider 里找。 */
const ADVISOR_SPEC = (process.env.PICHAT_ADVISOR_MODEL || "").trim();
/** 一轮里最多问几次（问多了又贵又拖时间）。 */
const MAX_PER_RUN = 3;

/** 顾问看到的那段话：说清它是谁、能干什么、回什么。 */
const SYSTEM_PROMPT = [
    "你是顾问。你看到的是一段正在进行的对话：另一个模型在做这件事，它停下来问你。",
    "你只能回话：不能调用工具、不能改文件、也不能替它干活。",
    "请直接给一段短而具体的判断：",
    "1. 它下一步该做什么（做什么、注意什么）；或者",
    "2. 它哪里想错了、该怎么改；或者",
    "3. 该不该停（做完了、不值得再花力气），并说清理由。",
    "不要重复对话里已经写清楚的内容，不要写大段代码，不要客套。用对话里那种语言回答。",
].join("\n");

const ASK_PARAMS = {
    type: "object",
    properties: {
        question: {
            type: "string",
            description: "你要问的是什么：卡在哪儿、已经试过什么、需要它帮你定哪一件事。写短一点，它自己看得到当前对话。",
        },
    },
    required: ["question"],
    additionalProperties: false,
};

const ASK_DESCRIPTION = ${JSON.stringify(promptText(over, "toolAdvisor"))};

/** 取字符串参数，顺手截断。 */
function text(v: unknown, limit: number): string | undefined {
    if (typeof v !== "string") { return undefined; }
    const t = v.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

/** 找到顾问模型：写了 provider/ 就用它；没写、或者找不到，就在执行器那个 provider 里按名字找。 */
function findAdvisor(ctx: any): any {
    const reg = ctx && ctx.modelRegistry;
    if (!reg || typeof reg.find !== "function") { return undefined; }
    const slash = ADVISOR_SPEC.indexOf("/");
    const wroteProvider = slash > 0;
    const provider = wroteProvider ? ADVISOR_SPEC.slice(0, slash) : "";
    const modelId = wroteProvider ? ADVISOR_SPEC.slice(slash + 1) : ADVISOR_SPEC;
    if (wroteProvider) {
        try {
            const got = reg.find(provider, modelId);
            if (got) { return got; }
        } catch { /* 接着试执行器那个 provider */ }
    }
    const current = ctx.model && ctx.model.provider;
    if (current) {
        try {
            const got = reg.find(current, modelId);
            if (got) { return got; }
        } catch { /* 找不到就是找不到 */ }
    }
    return undefined;
}

/**
 * 顾问能看的那份对话。
 *
 * 跟执行器看到的尽量一致，但要去掉几样它用不上的东西：
 *   - 系统消息（顾问有自己的那段话，pi 的整套规则和工具说明对它没意义）；
 *   - 图片（换成一行说明：顾问多半看不了，别为这个把整张图重传一遍）；
 *   - 思考块、以及各家模型私带的签名（换了模型看既没用，还可能被拒）；
 *   - 还没等到结果的工具调用 —— 执行器调 ask_advisor 那一刻，会话最后一条正是
 *     “带工具调用、还没有结果”的助手消息，原样发出去会被对方当成残缺的工具调用。
 *
 * 会话里的压缩摘要、叹号命令跑过的东西、扩展塞进来的话，先按 pi 自己那套（convertToLlm）
 * 变成普通消息：不然压缩过一回的会话，顾问看到的就从中间断开了。
 */
function buildMessages(ctx: any): any[] {
    let raw: any[] = [];
    try {
        const projection = ctx && ctx.sessionManager && ctx.sessionManager.buildSessionProjection
            ? ctx.sessionManager.buildSessionProjection()
            : undefined;
        raw = projection && Array.isArray(projection.messages) ? convertToLlm(projection.messages) : [];
    } catch { raw = []; }

    const answered = new Set();
    for (const msg of raw) {
        if (msg && msg.role === "toolResult" && typeof msg.toolCallId === "string") {
            answered.add(msg.toolCallId);
        }
    }

    const out: any[] = [];
    for (const msg of raw) {
        if (!msg || !msg.role) { continue; }
        if (msg.role === "system") { continue; }

        const content: any[] = [];
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
            if (!block || typeof block !== "object") { continue; }
            if (block.type === "text") {
                content.push({ type: "text", text: String(block.text == null ? "" : block.text) });
            } else if (block.type === "image") {
                content.push({ type: "text", text: "（这里原来是一张图，顾问看不到）" });
            } else if (block.type === "toolCall" && msg.role === "assistant" && answered.has(block.id)) {
                content.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments || {} });
            }
            // 别的块（思考、各家私带的签名之类）一律不带
        }
        if (content.length === 0) { continue; }

        if (msg.role === "toolResult") {
            out.push({
                role: "toolResult",
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                isError: msg.isError === true,
                content,
                timestamp: Date.now(),
            });
        } else if (msg.role === "user" || msg.role === "assistant") {
            out.push({ role: msg.role, content });
        }
    }
    return out;
}

/** 顾问回的那段字。 */
function replyText(result: any): string {
    if (!result || !Array.isArray(result.content)) { return ""; }
    const parts: string[] = [];
    for (const block of result.content) {
        if (block && block.type === "text" && typeof block.text === "string") { parts.push(block.text); }
    }
    return parts.join("\n").trim();
}

export default function advisorBridge(pi: any): void {
    // 没填顾问模型：这个工具就不存在，模型那边一个字都看不到
    if (!ADVISOR_SPEC) { return; }

    let used = 0;
    // 每一轮（用户说一句话算一轮）重新给次数：别让一次长会话把额度用光
    try {
        pi.on("agent_start", () => { used = 0; });
    } catch { /* 没有这个事件也不影响用 */ }

    try {
        pi.registerTool({
            name: "ask_advisor",
            label: "问顾问",
            description: ASK_DESCRIPTION,
            promptSnippet: "问顾问：卡住时把当前这一摊交给一个更强的模型看一眼，它只回一段计划。",
            parameters: ASK_PARAMS,
            // 一次问一个：几个顾问同时看同一段对话，又贵又没必要
            executionMode: "sequential",
            async execute(toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
                const question = text(params && params.question, 8000);
                if (!question) {
                    return {
                        content: [{ type: "text", text: "问不了：question 要写（卡在哪儿、试过什么）。" }],
                        details: { error: "missing question" },
                    };
                }
                if (used >= MAX_PER_RUN) {
                    return {
                        content: [{
                            type: "text",
                            text: "这一轮已经问过 " + MAX_PER_RUN + " 次顾问了。剩下的自己拿主意：把眼前的活干完，或者停下来问用户。",
                        }],
                        details: { skipped: "budget", maxPerRun: MAX_PER_RUN },
                    };
                }

                const advisor = findAdvisor(ctx);
                if (!advisor) {
                    return {
                        content: [{
                            type: "text",
                            text: "顾问模型没找到（设置里那行「顾问模型」写的是 " + ADVISOR_SPEC + "）。自己拿主意吧。",
                        }],
                        details: { error: "advisor model not found", spec: ADVISOR_SPEC },
                    };
                }

                const messages = buildMessages(ctx);
                messages.push({ role: "user", content: [{ type: "text", text: question }] });

                used += 1;
                let result: any;
                try {
                    const options: any = {};
                    if (signal) { options.signal = signal; }
                    if (advisor.reasoning) { options.reasoning = "high"; }
                    result = await ctx.modelRegistry
                        .streamSimple(advisor, { systemPrompt: SYSTEM_PROMPT, messages }, options)
                        .result();
                } catch (e: any) {
                    return {
                        content: [{
                            type: "text",
                            text: "问顾问没问成（" + String((e && e.message) || e) + "）。自己拿主意，别在这件事上反复重试。",
                        }],
                        details: { error: "call failed" },
                    };
                }

                const plan = replyText(result);
                if (!plan) {
                    const why = result && result.errorMessage ? String(result.errorMessage) : "没回内容";
                    return {
                        content: [{ type: "text", text: "顾问没给出建议（" + why + "）。自己拿主意。" }],
                        details: { error: "empty reply" },
                    };
                }

                const name = String((advisor.provider || "") + "/" + (advisor.id || ""));
                return {
                    content: [{
                        type: "text",
                        text: "顾问（" + name + "）说：\n\n" + plan
                            + "\n\n（这是建议：采不采纳自己判断，别说成已经发生的事。）",
                    }],
                    details: { model: name, usage: result && result.usage },
                };
            },
        });
    } catch {
        // 名字被别的扩展占了之类：这个工具就不出现，别让整个 pi 起不来
    }
}
`;
}
