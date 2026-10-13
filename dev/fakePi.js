#!/usr/bin/env node
// @ts-nocheck
/**
 * fakePi —— 假的 pi：按剧本演戏的 `pi --mode rpc`。
 *
 * 为什么要有它：用真模型验界面，一句话要等几十秒，还经常不按剧本走（不调工具、
 * 调的顺序不对），界面调试等不起。把 piPath 指到这个脚本，会话编排、历史、
 * 整屏重放、工具结果、读图——整条链路全是真的，只有"模型"是假的，秒回。
 *
 * 协议与真 pi 一致（stdin/stdout JSONL，见 pi 的 dist/modes/rpc/rpc-mode.js）：
 *   - 命令进来回 {type:"response", id, command, success, data}
 *   - 事件直接往外发：agent_start / message_start / message_update(assistantMessageEvent)
 *     / tool_execution_start|end / message_end / agent_end / agent_settled / session_info_changed
 *   - get_messages 回自己记的历史（assistant 消息 content 里是 thinking/text/toolCall，
 *     toolResult 单独成条）——这正是整屏重放时界面上看到的东西，所以重放路径也验得到。
 *
 * 剧本（每轮照着演一遍，可在文件顶部改）：
 *   1. 先想一段（thinking_start / 增量 / thinking_end，界面上出一个 think 标签）
 *   2. 说一句话（逐字推，模拟流式）
 *   3. 工具：read 一张图（结果带 image，走"读图变图片块"那条路）
 *   4. 工具：bash
 *   5. 工具：edit（会真的改 dev/.scratch 下的一个文件，diff 卡片有东西可看）
 *   6. 再说一句收尾
 *
 * 用法（不用记参数，插件的 piPath 指过来就行）：
 *   node dev/fakePi.js --mode rpc          # 参数收下但不看，照常演戏
 *
 * 配合调试工具（PICHAT_HOME 指到调试目录，不动真配置）：
 *   npm run web:dev -- --fake-pi
 *   npm run web:shot -- --fake-pi --send "随便" --shot x.png   # 秒回
 */
"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 剧本参数
// ---------------------------------------------------------------------------

/** 每轮开始前停多久（毫秒）：给"正在工作"的状态一点出场时间；0 = 完全秒回。 */
const THINK_MS = Number(process.env.FAKEPI_THINK_MS || 0);
/** 文字流式输出的间隔（毫秒）。 */
const TEXT_TICK_MS = Number(process.env.FAKEPI_TICK_MS || 0);
/** 单张图片的结果（base64 的小 png）：走 read 读图那条渲染路。 */
const SAMPLE_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEUlEQVR4nGP8z0AswAKTQNYA" +
    "AEGYAVfrEXvAAAAAAElFTkSuQmCC";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 本会话的消息历史（get_messages 原样给出去；形状照抄真 pi 的会话文件）。 */
const messages = [];
let seq = 0;
/** 剧本自己的状态（比如“标题已经报过了”）：不进行消息历史。 */
const scriptState = {};
const nextId = (prefix) => `${prefix}-${++seq}-${Date.now().toString(36)}`;
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const MODEL = { id: "fake-model", provider: "fake", name: "假模型（秒回）", contextWindow: 128000 };

/** 回话文件放在哪（插件用 PICHAT_ASK_DIR 告诉本进程，见 src/askAssets.ts 与 askProtocol.ts）。 */
const ASK_DIR = process.env.PICHAT_ASK_DIR || "";

/** 这一轮被停掉了（收到 abort 命令）：问话那一段看到它就当"没作答"交回去（真扩展看的是 signal）。 */
let aborted = false;

/**
 * 等插件把问话的答案写回来（真扩展也是这么轮询的，见 askBridgeSource.ts）。
 * 先写临时文件再改名，所以读到一半的 JSON 不会出现；读到了就把它删掉。
 */
async function waitAskAnswer(id, waitMs) {
    const file = ASK_DIR ? path.join(ASK_DIR, "ask-answers", id + ".json") : "";
    const deadline = Date.now() + waitMs;
    while (file && Date.now() < deadline && !aborted) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            try { fs.rmSync(file, { force: true }); } catch { /* 删不掉不影响 */ }
            if (parsed && parsed.id === id) { return parsed; }
        } catch { /* 还没写 / 写了一半：接着等 */ }
        await sleep(150);
    }
    return null;
}

/** 把回话文件里的答案念成扩展给模型的工具结果文本（跟 askBridgeSource.ts 里那几句一样）。 */
function answerText(answer) {
    if (!answer || answer.cancelled) { return "用户没作答。"; }
    const picked = Array.isArray(answer.picked) ? answer.picked : [];
    const written = typeof answer.text === "string" ? answer.text.trim() : "";
    const lines = [];
    if (picked.length === 1) { lines.push("用户选了：" + picked[0]); }
    else if (picked.length > 1) { lines.push("用户选了这几项：" + picked.join("、")); }
    if (written) { lines.push("用户还自己写了一句：" + written); }
    return lines.length ? lines.join("\n") : "用户没作答。";
}

/** 还等着的“扩展问用户”（extension_ui_request）：编号 → 收尾函数。 */
const uiWaiters = new Map();
let uiSeq = 0;

/**
 * 演一次“扩展问用户”（pi 的 extension_ui_request）：confirm / input / select 三种。
 * 等插件回一条 extension_ui_response（见 src/sessionRuntime.ts 的 onPiUiRequest）。
 * 真 pi 里这是扩展在跑工具中间问的；这里由剧本直接发，界面上看到的是同一张卡片。
 */
function askExtensionUi(method, fields, waitMs) {
    const id = `ui-${++uiSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => { uiWaiters.delete(id); resolve(null); }, waitMs);
        uiWaiters.set(id, (value) => { clearTimeout(timer); uiWaiters.delete(id); resolve(value); });
        write({ type: "extension_ui_request", id, method, ...fields });
    });
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function write(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(id, command, data) {
    write({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

// ---------------------------------------------------------------------------
// 事件：照真 pi 的顺序与形状发
// ---------------------------------------------------------------------------

async function runScript(userText) {
    const emit = (evt) => write(evt);
    const now = () => new Date().toISOString();
    aborted = false;

    // 用户的话里带“派活”就假装模型调了 taba_spawn（子会话收到的任务正文里也有“派活”两个字，
    // 那种要排除掉，不然子进程也会发一条）：往 stderr 写一行暗号（格式与真扩展一致，
    // 见 src/tabaProtocol.ts）。这条路径能验到：新开后台会话、父子关系、列表里缩进。
    if (/派活/.test(userText) && !/【任务】/.test(userText) && !scriptState.spawnSent) {
        scriptState.spawnSent = true;
        const frame = "##PICHAT_TABA##" + Buffer.from(JSON.stringify({
            kind: "spawn",
            id: "deadbeef",
            name: "假子会话",
            task: "看看子会话在列表里会不会缩进",
        }), "utf8").toString("base64");
        process.stderr.write(frame + "\n");
    }

    emit({ type: "agent_start" });

    // ---- 用户消息（pi 会把 prompt 作为 user 消息推一遍） ----
    const userMsg = { role: "user", content: [{ type: "text", text: userText }], timestamp: now() };
    messages.push(userMsg);
    emit({ type: "message_start", message: userMsg });
    emit({ type: "message_end", message: userMsg });

    // ---- 助手消息：文字 → 工具 ×3 → 文字，最后整条进历史 ----
    const assistantMsg = { role: "assistant", content: [], timestamp: now(), usage: {}, model: `${MODEL.provider}/${MODEL.id}` };
    emit({ type: "message_start", message: assistantMsg });

    /** 把已积累的内容条推进历史（message_update 的 partial 懒得发，界面靠增量事件就够了）。 */
    const say = async (text) => {
        const piece = { type: "text", text };
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "text_start", contentIndex: assistantMsg.content.length },
        });
        // 逐字推：模拟流式（FAKEPI_TICK_MS=0 时一次性给完）
        for (let i = 0; i < text.length; i += 6) {
            const delta = text.slice(i, i + 6);
            emit({
                type: "message_update",
                usage: {},
                assistantMessageEvent: { type: "text_delta", contentIndex: assistantMsg.content.length, delta },
            });
            await sleep(TEXT_TICK_MS);
        }
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "text_end", contentIndex: assistantMsg.content.length },
        });
        assistantMsg.content.push(piece);
    };

    /** 演一段思考：thinking_start → 逐字增量 → thinking_end（带整段文本），并把这段记进历史。 */
    const think = async (text) => {
        const piece = { type: "thinking", thinking: text };
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "thinking_start", contentIndex: assistantMsg.content.length },
        });
        for (let i = 0; i < text.length; i += 6) {
            emit({
                type: "message_update",
                usage: {},
                assistantMessageEvent: { type: "thinking_delta", contentIndex: assistantMsg.content.length, delta: text.slice(i, i + 6) },
            });
            await sleep(TEXT_TICK_MS);
        }
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "thinking_end", contentIndex: assistantMsg.content.length, content: text },
        });
        assistantMsg.content.push(piece);
    };

    /** 演一个工具调用：toolcall 事件 → 执行 → 结果进历史。 */
    const act = async (toolName, args, result) => {
        const id = nextId("call");
        // 参数是"正在生成"的部分：toolcall_start/delta/end 各发一条（界面在此期间只显示"工作中"）
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "toolcall_start", contentIndex: assistantMsg.content.length, id, toolName },
        });
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: {
                type: "toolcall_end", contentIndex: assistantMsg.content.length, id, toolName,
                partial: { type: "toolCall", id, name: toolName, arguments: args },
            },
        });
        assistantMsg.content.push({ type: "toolCall", id, name: toolName, arguments: args });

        emit({ type: "tool_execution_start", toolCallId: id, toolName, args });
        await sleep(THINK_MS);
        const toolResult = {
            role: "toolResult",
            toolCallId: id,
            content: result.content,
            isError: false,
            timestamp: now(),
        };
        emit({
            type: "tool_execution_end",
            toolCallId: id,
            toolName,
            args,
            result: result.raw,
            isError: false,
            durationMs: THINK_MS,
        });
        messages.push(toolResult);
        emit({ type: "message_start", message: toolResult });
        emit({ type: "message_end", message: toolResult });
    };

    /**
     * 演一次“模型问用户选择题”（ask_choice）：真扩展那套协议一模一样 ——
     * 工具调用进历史 → 往 stderr 写一行暗号（见 src/askProtocol.ts）→ 等插件写回话文件 → 工具结果。
     * 界面靠 toolCallId 把问话卡片挂到那条工具行下面，所以暗号里也带一份。
     */
    const askChoice = async (ask) => {
        const callId = nextId("call");
        const askId = nextId("ask");
        const args = {
            question: ask.question,
            options: ask.options,
            multi: ask.multi === true,
            recommended: ask.recommended || [],
            allowText: ask.allowText !== false,
        };
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "toolcall_start", contentIndex: assistantMsg.content.length, id: callId, toolName: "ask_choice" },
        });
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: {
                type: "toolcall_end", contentIndex: assistantMsg.content.length, id: callId, toolName: "ask_choice",
                partial: { type: "toolCall", id: callId, name: "ask_choice", arguments: args },
            },
        });
        assistantMsg.content.push({ type: "toolCall", id: callId, name: "ask_choice", arguments: args });
        emit({ type: "tool_execution_start", toolCallId: callId, toolName: "ask_choice", args });

        // 暗号：真扩展写在 stderr 上的一行（一行、base64，见 src/askProtocol.ts）
        process.stderr.write("##PICHAT_ASK##" + Buffer.from(JSON.stringify({
            kind: "ask",
            id: askId,
            ...args,
            toolCallId: callId,
        }), "utf8").toString("base64") + "\n");

        const answer = await waitAskAnswer(askId, 120000);
        if (!answer) {
            // 不等了（这一轮被停 / 等超时）：跟插件说一声，把界面上那张卡片收掉
            //（跟真扩展一样，见 askBridgeSource.ts 的 ask-done）
            process.stderr.write("##PICHAT_ASK##" + Buffer.from(JSON.stringify(
                { kind: "ask-done", id: askId },
            ), "utf8").toString("base64") + "\n");
        }
        const text = answerText(answer);
        const toolResult = {
            role: "toolResult",
            toolCallId: callId,
            content: [{ type: "text", text }],
            isError: false,
            timestamp: now(),
        };
        emit({
            type: "tool_execution_end", toolCallId: callId, toolName: "ask_choice", args,
            result: { content: [{ type: "text", text }], details: { id: askId } },
            isError: false, durationMs: 0,
        });
        messages.push(toolResult);
        emit({ type: "message_start", message: toolResult });
        emit({ type: "message_end", message: toolResult });
        return text;
    };

    /** 这一轮演完了：收尾（下面两条路都走它）。 */
    const finish = () => {
        assistantMsg.stopReason = "stop";
        messages.push(assistantMsg);
        emit({ type: "message_end", message: assistantMsg });
        emit({ type: "agent_end", messages });
        // 假装装了一个自动命名扩展：第一轮跑完后把会话标题报上来（真 pi 里是扩展发的）。
        // 界面顶条中间那行 / 会话列表都读这个标题；没标题时才回落随机名。
        if (!scriptState.titleSent) {
            scriptState.titleSent = true;
            const firstUser = messages.find((m) => m && m.role === "user");
            const firstText = firstUser && Array.isArray(firstUser.content)
                ? (firstUser.content.find((c) => c && c.type === "text") || {}).text
                : "";
            const title = "假标题：" + String(firstText || "新会话").replace(/s+/g, " ").trim().slice(0, 12);
            messages.push({ role: "system", content: [{ type: "text", text: "会话标题已设置" }], sessionName: title });
            emit({ type: "session_info_changed", name: title });
        }
        emit({ type: "agent_settled" });
    };

    // ---- 问话那几种（调试用：一句话就演一类，不用真模型；见 dev/askCards.js）----
    // 前两种是模型调 ask_choice（走 stderr 暗号 + 回话文件），后三种是扩展在中间问用户
    // （走 extension_ui_request，跟真的扩展提问同一条路）。
    const askKind = /问多选/.test(userText) ? "multi"
        : /问单选/.test(userText) ? "single"
            : /问确认/.test(userText) ? "confirm"
                : /问输入/.test(userText) ? "input"
                    : /问选项/.test(userText) ? "select" : "";
    if (askKind) {
        await say("（假模型）我演一次问话：" + askKind);
        let reply = "";
        if (askKind === "single") {
            reply = await askChoice({ question: "选 A 还是 B？", options: ["A", "B"], recommended: [1] });
        } else if (askKind === "multi") {
            reply = await askChoice({ question: "哪几项要？", options: ["甲", "乙", "丙"], multi: true, recommended: [1, 3] });
        } else if (askKind === "confirm") {
            const back = await askExtensionUi("confirm", { title: "要跑这条命令吗？", message: "rm -rf /tmp/x" }, 120000);
            reply = back ? "扩展收到 confirmed=" + String(back.confirmed) : "扩展没等到回话。";
        } else if (askKind === "input") {
            const back = await askExtensionUi("input", { title: "会话叫什么名字？", placeholder: "写一个", prefill: "默认名" }, 120000);
            reply = back ? "扩展收到 " + JSON.stringify(back.cancelled ? null : back.value) : "扩展没等到回话。";
        } else {
            const back = await askExtensionUi("select", { title: "用哪个？", options: ["第一个", "第二个", "第三个"] }, 120000);
            reply = back ? "扩展收到 " + JSON.stringify(back.cancelled ? null : back.value) : "扩展没等到回话。";
        }
        await say("问话结束 —— " + reply);
        finish();
        return;
    }

    await think("用户要的是演示，那就按老剧本走一遍：先读图，再 bash，再改一下文件。");
    await say("好，我用三个工具给你演示一遍（假模型秒回）：");    await act("read", { path: "示例图片.png" }, {
        content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: SAMPLE_PNG_BASE64, mimeType: "image/png" },
        ],
        raw: { content: [{ type: "text", text: "Read image file [image/png]" }], details: { dims: "10x10" } },
    });
    await act("bash", { command: "ls" }, {
        content: [{ type: "text", text: "示例.js\n示例图片.png\n说明.txt" }],
        raw: { content: [{ type: "text", text: "示例.js\n示例图片.png\n说明.txt" }], exitCode: 0 },
    });
    await act("edit", { path: "说明.txt", oldText: "调试", newText: "调试（假模型改的）" }, {
        content: [{ type: "text", text: "已编辑" }],
        raw: {
            content: [{ type: "text", text: "已编辑" }],
            details: { diff: "--- 说明.txt\n+++ 说明.txt\n@@ -1 +1 @@\n-这是 Pi Chat 插件的调试用工作目录（dev/.scratch）。\n+这是 Pi Chat 插件的调试用工作目录（dev/.scratch）（假模型改的）。\n" },
        },
    });
    await say("完事。三个工具都跑过了：read（带图）、bash、edit。");
    finish();
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

const SCRIPT_FILE = "说明.txt";

/** edit 工具真的改文件：编辑卡片（diff）才有东西可看，回滚也有的滚。 */
function applyFakeEdit(args) {
    try {
        const p = path.resolve(process.cwd(), args.path || SCRIPT_FILE);
        const text = fs.readFileSync(p, "utf8");
        if (typeof args.oldText === "string" && text.includes(args.oldText)) {
            fs.writeFileSync(p, text.replace(args.oldText, args.newText ?? ""), "utf8");
            return true;
        }
    } catch { /* 改不了就算了，剧本照演 */ }
    return false;
}

async function handle(cmd) {
    const id = cmd.id;
    switch (cmd.type) {
        // 扩展问用户的回话（见上边的 askExtensionUi）
        case "extension_ui_response": {
            const waiter = uiWaiters.get(cmd.id);
            if (waiter) { waiter(cmd); }
            return;
        }
        // 剧本（每轮照着演一遍）：1 说一句 → 2 read 图 → 3 bash → 4 edit → 5 收尾。
        // 用户这句话里带“派活”时，先往 stderr 写一行暗号（假扮模型调了 taba_spawn）。
        case "prompt": {
            // 真 pi：preflight 成功先回一次 response，然后事件流，最后 agent_settled
            respond(id, "prompt", { disposition: "handled" });
            void runScript(String(cmd.message || ""));
            return;
        }
        case "get_state":
            respond(id, "get_state", {
                model: MODEL,
                thinkingLevel: "off",
                isStreaming: false,
                sessionFile: path.join(process.cwd(), "fake-session.jsonl"),
                sessionId: "fake-session",
                sessionName: "假会话（fakePi）",
                messageCount: messages.length,
            });
            return;
        case "get_available_models":
            respond(id, "get_available_models", { models: [{ ...MODEL, reasoning: false, cost: { input: 0, output: 0 } }] });
            return;
        case "set_model":
            respond(id, "set_model", MODEL);
            return;
        case "set_thinking_level":
        case "new_session":
            if (cmd.type === "new_session") { messages.length = 0; }
            respond(id, cmd.type, {});
            return;
        case "get_session_stats":
            respond(id, "get_session_stats", { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: { percent: 1, tokens: 1000, contextWindow: MODEL.contextWindow } });
            return;
        case "get_commands":
            respond(id, "get_commands", { commands: [{ name: "fake-hello", description: "假命令", source: "extension" }] });
            return;
        case "get_messages":
            respond(id, "get_messages", { messages });
            return;
        case "get_last_assistant_text": {
            const last = [...messages].reverse().find((m) => m.role === "assistant");
            const text = last ? (last.content || []).filter((c) => c.type === "text").map((c) => c.text).join("") : "";
            respond(id, "get_last_assistant_text", { text });
            return;
        }
        case "switch_session":
            messages.length = 0;
            respond(id, "switch_session", { cancelled: false });
            return;
        case "abort":
        case "abort_bash":
        case "clear_queue":
            // 停掉这一轮：正等着的问话也当没作答（真扩展那边是工具的 signal 触发的）
            if (cmd.type === "abort") { aborted = true; }
            respond(id, cmd.type, {});
            return;
        case "bash":
            respond(id, "bash", { content: [{ type: "text", text: "（假模型不执行 bash）" }], exitCode: 0 });
            return;
        default:
            respond(id, cmd.type, {});
    }
}

// ---------------------------------------------------------------------------
// stdin JSONL
// ---------------------------------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) { break; }
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) { continue; }
        let cmd;
        try { cmd = JSON.parse(line); } catch { continue; }
        if (cmd && cmd.type === "edit") { applyFakeEdit(cmd); } // 理论上不会来，兜一手
        void handle(cmd);
    }
});
process.stdin.on("end", () => process.exit(0));

// 起来就绪：真 pi 起进程也要一小会，这里留个可调的延迟，测"会话还没就绪"的界面时用
const BOOT_MS = Number(process.env.FAKEPI_BOOT_MS || 0);
if (BOOT_MS > 0) {
    const t0 = Date.now();
    const busy = () => {
        if (Date.now() - t0 >= BOOT_MS) { return; }
        setTimeout(busy, 50);
    };
    busy();
}
