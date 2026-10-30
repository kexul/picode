/**
 * 问话（ask_choice）：塞进 pi 进程里的那个扩展文件的源码。
 *
 * 插件启动时把下面这份源码写到 <pichatDir>/ask-bridge-<插件版本>.ts，
 * 每个会话的 pi 进程启动时都用 `-e <那个文件>` 加载它。
 * 注意不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 用户在终端里手跑的 pi 也会被塞上这个工具 —— 它只有插件的会话里才有意义。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留（比如 "\n" 不能被外层先转义成真换行）。
 */
import { ASK_FRAME_PREFIX } from "./askProtocol";
import { promptText, type PromptOverrides } from "./promptText";

export function askBridgeSource(over?: PromptOverrides): string {
    return String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：给模型一个工具 ask_choice，让它问用户"选一个 / 选几个"的选择题，
 * 用户在这块界面上点几下作答（列表 + 勾选 + 自己写），答案回到模型手里。
 *
 * 工具被调用时：
 *   1. 往本进程的 stderr 写一行暗号：${ASK_FRAME_PREFIX} 后面跟 base64 编码的 JSON（问题、选项都在里面）；
 *   2. 等插件把答案写进 <PICHAT_ASK_DIR>/ask-answers/<提问编号>.json（每 150 毫秒看一次）；
 *   3. 读到就把那个文件删掉，然后把作答内容当作工具结果交回模型。
 *
 * 插件不在（没人在看那块界面）时，插件会直接写一份"没作答"的回话过来，不会让这个工具干等。
 * 这一轮被停掉（用户按了停止/Esc）或者等得太久时，这里会写一条"不等了"的暗号，
 * 让插件把还开着的浮层收掉。
 */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const FRAME_PREFIX = ${JSON.stringify(ASK_FRAME_PREFIX)};
/** 隔多久看一次回话文件。 */
const POLL_MS = 150;
/**
 * 最多等多久（用户一直没答就放弃：别把这一轮永久堵住）。
 *
 * 宿主那边等到点就先放弃了（见 chatHost.ts 的 ASK_WAIT_MS，比这个短）：它一放弃，界面上那张
 * 卡片就没了，这里再等也只是为了把话说明白 —— 所以下面那句提示不报具体分钟数，免得两边对不上。
 */
const WAIT_LIMIT_MS = 30 * 60 * 1000;

/** 往 stderr 写一行暗号。 */
function emit(payload: Record<string, unknown>): void {
    try {
        process.stderr.write(FRAME_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
    } catch {
        // 写不出去就算了：插件那边表现为"没弹框"，下面等回话会等到超时
    }
}

/** 资源目录（插件用 PICHAT_ASK_DIR 告诉本进程）。 */
function resourceDir(): string {
    const dir = process.env.PICHAT_ASK_DIR;
    return typeof dir === "string" ? dir.trim() : "";
}

/** 这次提问的回话文件在哪。 */
function answerFile(id: string): string {
    const dir = resourceDir();
    return dir ? join(dir, "ask-answers", id + ".json") : "";
}

/** 读回话（没写出来 / 写了一半 / 不是这次提问的，都当没有）。 */
function readAnswer(id: string): any {
    const file = answerFile(id);
    if (!file) { return undefined; }
    let parsed: any;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
    return parsed && parsed.id === id ? parsed : undefined;
}

/** 读到了就把文件删掉（留着也是垃圾）。 */
function dropAnswer(id: string): void {
    const file = answerFile(id);
    if (!file) { return; }
    try { unlinkSync(file); } catch { /* 删不掉不影响用 */ }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等插件回话；signal 是这一轮的取消信号（用户按停止）。 */
async function waitAnswer(id: string, signal: any): Promise<{ answer?: any; why: "answered" | "cancelled" | "timeout" }> {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    for (;;) {
        const got = readAnswer(id);
        if (got) { dropAnswer(id); return { answer: got, why: "answered" }; }
        if (signal && signal.aborted) { return { why: "cancelled" }; }
        if (Date.now() > deadline) { return { why: "timeout" }; }
        await sleep(POLL_MS);
    }
}

/** 取字符串参数，顺手截断。 */
function text(v: unknown, limit: number): string | undefined {
    if (typeof v !== "string") { return undefined; }
    const t = v.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

/** 会话文件路径（插件拿它认"这次提问是哪个会话"）。 */
function sessionFileOf(ctx: any): string {
    try {
        const got = ctx?.sessionManager?.getSessionFile?.();
        return typeof got === "string" ? got : "";
    } catch {
        return "";
    }
}

/** 推荐项：模型可能给一个数，也可能给一串数；统一成从 1 数起的下标数组。 */
function recommendedIndexes(raw: unknown, count: number): number[] {
    const list = Array.isArray(raw) ? raw : (typeof raw === "number" ? [raw] : []);
    const out: number[] = [];
    for (const item of list) {
        const n = typeof item === "number" ? item : NaN;
        if (Number.isInteger(n) && n >= 1 && n <= count && out.indexOf(n) < 0) { out.push(n); }
    }
    out.sort((a, b) => a - b);
    return out;
}

const ASK_PARAMS = {
    type: "object",
    properties: {
        question: {
            type: "string",
            description: "要问的问题。界面上是一行标题，写短一点；长的背景说明写在你自己的正文里。",
        },
        options: {
            type: "array",
            items: { type: "string" },
            description: "选项，2 到 8 个。每个都写短一点、能独立看懂的一句话。",
        },
        multi: {
            type: "boolean",
            description: "能不能勾多个（默认 false = 单选）。要问「这几项里你想要哪些」就传 true。",
        },
        recommended: {
            anyOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
            description: "你推荐哪几项：从 1 数起的下标。单选给一个数（如 1），多选给一串（如 [1,3]）。界面上会给这几项加个「我推荐」的标记。",
        },
        allowText: {
            type: "boolean",
            description: "要不要「自己写」那一行（默认要）。选项里都不合适时，用户可以自己写一句话当答案。",
        },
    },
    required: ["question", "options"],
    additionalProperties: false,
};

const ASK_DESCRIPTION = ${JSON.stringify(promptText(over, "toolAsk"))};

/** 注册一个工具；名字被别人占了就跳过（不要让整个 pi 起不来）。 */
function safeRegister(pi: any, def: any): void {
    try {
        pi.registerTool(def);
    } catch (e: any) {
        emit({ kind: "note", tool: def && def.name, error: String((e && e.message) || e).slice(0, 300) });
    }
}

export default function askBridge(pi: any): void {
    safeRegister(pi, {
        name: "ask_choice",
        label: "问用户选择题",
        description: ASK_DESCRIPTION,
        promptSnippet: "问用户一个选择题（单选 / 多选），让他在界面上点选，不用自己打字。",
        parameters: ASK_PARAMS,
        // 一次只问一个：几个问题同时弹出来会互相抢界面
        executionMode: "sequential",
        async execute(toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
            const question = text(params?.question, 4000);
            const rawOptions = Array.isArray(params?.options) ? params.options : [];
            const options: string[] = [];
            for (const item of rawOptions) {
                const label = text(item, 400);
                if (label) { options.push(label); }
                if (options.length >= 8) { break; }
            }
            if (!question || options.length < 2) {
                return {
                    content: [{ type: "text", text: "问不了：question 要有，options 至少给两个。" }],
                    details: { error: "missing question or options" },
                };
            }

            const id = randomBytes(4).toString("hex");
            const payload: Record<string, unknown> = {
                kind: "ask",
                id,
                question,
                options,
                multi: params?.multi === true,
                recommended: recommendedIndexes(params?.recommended, options.length),
                allowText: params?.allowText !== false,
                // 界面拿这个把问话卡片挂到这条工具行下面（插件那边收到后原样传给界面）
                toolCallId: typeof toolCallId === "string" ? toolCallId.slice(0, 128) : "",
                parentSessionFile: sessionFileOf(ctx),
            };
            emit(payload);

            const waited = await waitAnswer(id, signal);
            if (waited.why !== "answered") {
                // 不等了：跟插件说一声，把界面上还等着的那张卡片收掉
                emit({ kind: "ask-done", id });
                const why = waited.why === "cancelled"
                    ? "这一轮被停掉了，用户没来得及作答。"
                    : "用户一直没作答。";
                return {
                    content: [{ type: "text", text: why + "不要再重复问这个问题：等用户开口。" }],
                    details: { id, cancelled: true, reason: waited.why },
                };
            }

            const got = waited.answer || {};
            const picked: string[] = Array.isArray(got.picked) ? got.picked.filter((x: unknown) => typeof x === "string") : [];
            const written = typeof got.text === "string" ? got.text.trim() : "";
            if (picked.length === 0 && !written) {
                return {
                    content: [{ type: "text", text: "用户把问题关了、没有作答。不要再重复问这个问题：等用户开口。" }],
                    details: { id, cancelled: true, picked: [], text: "" },
                };
            }

            const lines: string[] = [];
            if (picked.length === 1) { lines.push("用户选了：" + picked[0]); }
            else if (picked.length > 1) { lines.push("用户选了这几项：" + picked.join("、")); }
            if (written) { lines.push("用户还自己写了一句：" + written); }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { id, cancelled: false, picked, text: written },
            };
        },
    });
}
`;
}
