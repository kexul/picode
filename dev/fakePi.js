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
 * 用户这句话里带「假装被杀」时，起一条工具然后进程直接退出（不报结束）：验「结果永远回不来」的
 * 调用在界面上不再一直转圈（那一颗标签会被收掉）。
 * 用户这句话里带「碰文件」时演另一段（见 runScript 里那一段）：read 几个特意铺好的文件，
 * 好让后端那份「这个会话碰过的文件」清单里有子目录里的文件、也有会话目录外面的。
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
/** 让这轮里的思考与 bash 输出变多长（字符数；0 = 剧本原样）：
 *  验“思考 / 工具输出一个字都不发、点开再取”那条路时用，见 dev/liveDetail.js。 */
const LONG_TEXT_CHARS = Number(process.env.FAKEPI_LONG || 0);
/** 思考的收尾（thinking_end）拖到正文开始之后才发（1 = 像真 pi 的 openai-completions 适配器：
 *  正文边流边给，整条流跑完才把每个块收尾），见 dev/thinkDetail.js。 */
const LATE_THINK_END = !!process.env.FAKEPI_LATE_THINK_END;

/** 让这一轮最后那句收尾话变多长（字符数；0 = 剧本原样）：
 *  验“跑完一轮推到微信的那条摘要有多长”时用，见 dev/weixinPush.js。 */
const REPLY_LONG_CHARS = Number(process.env.FAKEPI_REPLY_LONG || 0);

/** 把一段文字撑到 n 个字符（不够就顺着编号往下写）。 */
function padTo(text, n) {
    if (n <= text.length) { return text; }
    const parts = [text];
    let i = 1;
    while (parts.join("").length < n) { parts.push("\n第 " + i + " 段：" + text); i += 1; }
    return parts.join("").slice(0, n);
}
/** 单张图片的结果（base64 的小 png）：走 read 读图那条渲染路。 */
const SAMPLE_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEUlEQVR4nGP8z0AswAKTQNYA" +
    "AEGYAVfrEXvAAAAAAElFTkSuQmCC";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 本会话的消息历史（get_messages 原样给出去；形状照抄真 pi 的会话文件）。 */
// 开头这条 system 也照抄：真 pi 的会话都从“初始提示 + 工具清单”这一条起头，get_messages 里带着它
// （界面上不画它，但算“还有没有更早的”时要认出来，见 src/sessionRuntime.ts 的 sliceHistoryWindow）。
const messages = [{ role: "system", content: [{ type: "text", text: "初始提示 + 工具清单（假 pi 的占位）" }], timestamp: 0 }];
let seq = 0;
/** 剧本自己的状态（比如“标题已经报过了”）：不进行消息历史。 */
const scriptState = {};
const nextId = (prefix) => `${prefix}-${++seq}-${Date.now().toString(36)}`;
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const MODEL = { id: "fake-model", provider: "fake", name: "假模型（秒回）", contextWindow: 128000 };

/** 这一轮被停掉了（收到 abort 命令）：桥靠 signal.aborted 判断，这里给它一个假的（见 fakeSignal）。 */
let aborted = false;
/** 剧本被 abort 打断时抛它：一路抛到 runScript 外面（那一轮已经收尾了，外面接着收干净就行）。 */
const ABORTED = new Error("aborted");

// ---------------------------------------------------------------------------
// 真扩展（"桥"）：加载宿主写下的那两个 .ts，让剧本调的是真代码
// ---------------------------------------------------------------------------
// 真 pi 用 `-e <那个文件>` 加载宿主写好的桥（见 src/bridgeAssets.ts）。这里加载同一份文件：
// 以前这一段是"自己拼暗号、自己读回话"，跟真代码长得像而已 —— 真代码（src/tabaBridgeSource.ts /
// src/askBridgeSource.ts）在自动检查里一次都没跑过，改了字段名也不会有人发现。
// 加载方式和真 pi 一样要的是那个文件本身；Node 24 能直接加载 .ts。
const bridgeTools = new Map();
const piShim = {
    registerTool(def) {
        if (def && typeof def.name === "string") { bridgeTools.set(def.name, def); }
    },
};

/** 加载一个桥文件（真 pi 的 `-e <文件>` 就是干这个）。 */
function loadBridgeFile(file) {
    try {
        const loaded = require(file);
        const factory = loaded && (loaded.default || loaded);
        if (typeof factory !== "function") { throw new Error("导出的不是一个函数"); }
        factory(piShim);
    } catch (e) {
        console.error("[假 pi] 加载 " + file + " 失败：" + String(e && e.message));
    }
}

/** 从资源目录里找宿主写下的桥文件并加载；找不到就明说（那几样工具这次验不了，别装作能验）。 */
function loadBridges() {
    for (const pair of [["PICHAT_TABA_DIR", "taba-bridge"], ["PICHAT_ASK_DIR", "ask-bridge"]]) {
        const envName = pair[0], prefix = pair[1];
        const dir = process.env[envName] || "";
        if (!dir) { console.error("[假 pi] 环境里没有 " + envName + "：" + prefix + " 那套工具这次跑不了。"); continue; }
        let file = "";
        try {
            file = fs.readdirSync(dir).find((n) => n.startsWith(prefix) && n.endsWith(".ts")) || "";
        } catch (e) {
            console.error("[假 pi] 读不了 " + dir + "：" + String(e && e.message));
            continue;
        }
        if (!file) { console.error("[假 pi] " + dir + " 里找不到 " + prefix + "-*.ts：那套工具这次跑不了。"); continue; }
        loadBridgeFile(path.join(dir, file));
    }
    // 命令行上直接指过来的扩展（`-e <文件>`）：逐字对齐真 pi 的写法，
    // 免得这里验的和真跑的不是同一份加载方式
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== "-e" || i + 1 >= argv.length) { continue; }
        loadBridgeFile(argv[i + 1]);
        i++;
    }
}
loadBridges();

// `--tools` 是白名单、`--no-tools` 是一个都不给：真 pi 用它过滤工具（连扩展注册的那些也一起过一遍，
// 不在名单里就不给模型）。这里照着挡一道 —— 不挡的话，“给了工具限制、结果跟真 pi 不一样”这种错在调试里看不见。
const allowedTools = (() => {
    const argv = process.argv.slice(2);
    if (argv.indexOf("--no-tools") >= 0) { return []; }
    const at = argv.indexOf("--tools");
    if (at < 0 || at + 1 >= argv.length) { return null; }
    return argv[at + 1].split(",").map((s) => s.trim()).filter(Boolean);
})();
if (allowedTools) {
    for (const name of Array.from(bridgeTools.keys())) {
        if (allowedTools.indexOf(name) >= 0) { continue; }
        bridgeTools.delete(name);
        console.error("[假 pi] --tools 白名单里没有 " + name + "：这个扩展工具这次不给模型。");
    }
}

/** 这个假会话的 .jsonl。真 pi 每记一条就往会话文件里追加，插件有些路会去读它
 *  （# 引用、派子会话时把父会话的文件交给子会话）；这里照写一份，那些路才验得到。
 *  每个进程一个名字（真 pi 里也是一个会话一个文件），会话一多也不会互相盖掉。 */
const sessionFile = path.join(process.cwd(), "fake-session-" + process.pid + ".jsonl");
function appendSession(record) {
    try { fs.appendFileSync(sessionFile, JSON.stringify(record) + "\n", "utf8"); } catch { /* 写不进去就算了 */ }
}

/** 桥要的两样东西：这个会话在哪个目录、它的 .jsonl 在哪（见 tabaBridgeSource.ts 的 cwdOf / sessionFileOf）。 */
function bridgeCtx() {
    return {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => sessionFile },
    };
}

/** 假的 abort 信号：桥只读 aborted（真 pi 给的是 AbortSignal）。 */
function fakeSignal() {
    return {
        get aborted() { return aborted; },
        addEventListener() { /* 桥不监听事件，只读上面的 aborted */ },
        removeEventListener() { /* 同上 */ },
    };
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

    emit({ type: "agent_start" });

    // ---- 用户消息（pi 会把 prompt 作为 user 消息推一遍） ----
    const userMsg = { role: "user", content: [{ type: "text", text: userText }], timestamp: now() };
    messages.push(userMsg);
    appendSession({ type: "message", message: userMsg });
    emit({ type: "message_start", message: userMsg });
    emit({ type: "message_end", message: userMsg });

    // ---- 助手消息：文字 → 工具 ×3 → 文字，最后整条进历史 ----
    const assistantMsg = { role: "assistant", content: [], timestamp: now(), usage: {}, model: `${MODEL.provider}/${MODEL.id}` };
    emit({ type: "message_start", message: assistantMsg });
    /** 拖到正文开头的收尾（FAKEPI_LATE_THINK_END）：{ 内容, 块号 }，由 say 发出去。 */
    let lateThinkEnd = null;

    /** 等一会儿；醒来发现这一轮已经被停掉了（收到过 abort）就当场收手 ——
     *  真 pi 收到 abort 也是立刻停，界面上按 Esc / 点「卡住了」才验得出效果。
     *  收尾事件先发完（这一轮结束），再抛 ABORTED 把剩下的剧本打断。 */
    const pause = async (ms) => {
        await sleep(ms);
        if (!aborted) { return; }
        assistantMsg.stopReason = "aborted";
        messages.push(assistantMsg);
        emit({ type: "message_end", message: assistantMsg });
        emit({ type: "agent_end", messages });
        emit({ type: "agent_settled" });
        throw ABORTED;
    };

    /** 把已积累的内容条推进历史（message_update 的 partial 懒得发，界面靠增量事件就够了）。 */
    const say = async (text) => {
        const piece = { type: "text", text };
        emit({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "text_start", contentIndex: assistantMsg.content.length },
        });
        if (lateThinkEnd) {
            const late = lateThinkEnd;
            lateThinkEnd = null;
            emit({
                type: "message_update",
                usage: {},
                assistantMessageEvent: { type: "thinking_end", contentIndex: late.index, content: late.text },
            });
        }
        // 逐字推：模拟流式（FAKEPI_TICK_MS=0 时一次性给完）
        for (let i = 0; i < text.length; i += 6) {
            const delta = text.slice(i, i + 6);
            emit({
                type: "message_update",
                usage: {},
                assistantMessageEvent: { type: "text_delta", contentIndex: assistantMsg.content.length, delta },
            });
            await pause(TEXT_TICK_MS);
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
            await pause(TEXT_TICK_MS);
        }
        if (LATE_THINK_END) {
            lateThinkEnd = { text, index: assistantMsg.content.length };
        } else {
            emit({
                type: "message_update",
                usage: {},
                assistantMessageEvent: { type: "thinking_end", contentIndex: assistantMsg.content.length, content: text },
            });
        }
        assistantMsg.content.push(piece);
    };

    /** 发"模型正在调工具"那几个事件，返回这次调用的编号。 */
    const beginTool = (toolName, args) => {
        const id = nextId("call");
        // 参数是"正在生成"的部分：toolcall_start/end 各发一条（界面在此期间只显示"工作中"）
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
        return id;
    };

    /** 结果收尾：tool_execution_end + 结果进历史。 */
    const endTool = (id, toolName, args, content, raw, isError) => {
        const toolResult = { role: "toolResult", toolCallId: id, content, isError: isError === true, timestamp: now() };
        emit({
            type: "tool_execution_end", toolCallId: id, toolName, args,
            result: raw, isError: isError === true, durationMs: THINK_MS,
        });
        messages.push(toolResult);
        emit({ type: "message_start", message: toolResult });
        emit({ type: "message_end", message: toolResult });
    };

    /** 演一个工具调用：结果由剧本给（真扩展注册的那些走 actReal）。 */
    const act = async (toolName, args, result) => {
        const id = beginTool(toolName, args);
        await pause(THINK_MS);
        // edit 真去改那个文件：界面上「改动」那一格是后端拿「改之前 / 改之后」比出来的，
        // 假模型光报一段 diff 而不真改文件，那一格就永远空着。
        // 改之前先等一小会：后端收到「工具开始」才去读「改之前」那一份，两个进程之间就靠这段时间差。
        if (toolName === "edit" || toolName === "write") { await pause(150); applyToolChange(toolName, args); }
        endTool(id, toolName, args, result.content, result.raw, false);
    };

    /**
     * 调一个"宿主写下的真扩展"注册的工具：事件跟 act 一样，但执行的是真代码 ——
     * 暗号由它写、回话由它读、名录由它查，跟真跑一模一样。
     */
    const actReal = async (toolName, args) => {
        const id = beginTool(toolName, args);
        const def = bridgeTools.get(toolName);
        if (!def) {
            const content = [{ type: "text", text: "（假 pi）没加载到「" + toolName + "」这个工具：桥文件没写成？" }];
            endTool(id, toolName, args, content, { content }, true);
            return "";
        }
        const res = await def.execute(id, args, fakeSignal(), undefined, bridgeCtx());
        const content = Array.isArray(res && res.content) ? res.content : [];
        endTool(id, toolName, args, content, res, false);
        return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
    };

    /**
     * 演一次“模型问用户选择题”（ask_choice）：调的是真扩展注册的那个工具 ——
     * 暗号由它写、回话由它去读（界面靠 toolCallId 把卡片挂到这条工具行下面，也是它带的）。
     */
    const askChoice = async (ask) => {
        return await actReal("ask_choice", {
            question: ask.question,
            options: ask.options,
            multi: ask.multi === true,
            recommended: ask.recommended || [],
            allowText: ask.allowText !== false,
        });
    };

    /** 这一轮演完了：收尾（下面两条路都走它）。 */
    const finish = () => {
        assistantMsg.stopReason = "stop";
        messages.push(assistantMsg);
        appendSession({ type: "message", message: assistantMsg });
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

    // ---- 子会话那三个工具（调试用：一句话演一个；调的是真扩展的代码）----
    // 派活 = taba（新开子会话）；看子会话 = taba_peek（读名录）；停掉子会话 = taba_stop。
    // 子会话收到的任务正文里也有“派活”两个字：那种要排除掉，不然子进程也会演一遍。
    // 子会话收到的任务正文（带【任务】那段）里也有"派活""子会话"这些字：那三种都别让子进程再演一遍
    const isChildTask = /【任务】/.test(userText);
    // 子会话故意磨一会儿才回话：测「趁它还在跑的时候把它停掉」那一幕要用（不然子会话
    // 几百毫秒就跑完、tab 都被关掉了，taba_stop 只能回「找不到」）。停了会当场抛 ABORTED（见 pause）。
    if (isChildTask) {
        const slow = Number(process.env.FAKEPI_CHILD_SLOW_MS || 0);
        if (slow > 0) { await pause(slow); }
    }
    const tabaKind = (!isChildTask && /派活/.test(userText)) ? "spawn"
        : (!isChildTask && /看子会话/.test(userText)) ? "peek"
            : (!isChildTask && /停掉子会话/.test(userText)) ? "stop" : "";
    if (tabaKind) {
        await say("（假模型）我演一次子会话工具：" + tabaKind);
        const reply = tabaKind === "spawn"
            ? await actReal("taba", { name: "假子会话", task: "看看子会话在列表里会不会缩进" })
            : tabaKind === "peek"
                ? await actReal("taba_peek", { name: "假子会话" })
                : await actReal("taba_stop", { name: "假子会话" });
        await say("子会话工具回话 —— " + reply);
        finish();
        return;
    }

    // ---- 自动接着干（/auto）的判官那一轮（见 auto.ts 的 autoJudge）：一句话判"继不继续" ----
    // 判官是另起的 pi 进程，每轮一份：轮数记在会话目录里的一个文件上，跨进程才数得对。
    //   FAKEPI_AUTO_STOP_ON=n  第 n 轮开始说「结束」（默认 2：前一轮继续、后一轮收工）
    if (/判断主会话还要不要接着干/.test(userText)) {
        // 判官一般要跑一会儿；这里可以把它拖慢一点，好让「判官正在看」在界面上露出来
        await pause(Number(process.env.FAKEPI_JUDGE_MS || 0));
        const counterFile = path.join(process.cwd(), ".judge-rounds");
        let round = 1;
        try { round = (Number(fs.readFileSync(counterFile, "utf8")) || 0) + 1; } catch { round = 1; }
        try { fs.writeFileSync(counterFile, String(round), "utf8"); } catch { /* 写不进去就当第一轮 */ }
        const stopOn = Number(process.env.FAKEPI_AUTO_STOP_ON || 2);
        const stop = round >= stopOn;
        await say(stop
            ? "结束\n（假判官）它说活干完了。"
            : "继续\n（假判官）它说还有没做完的。");
        finish();
        return;
    }

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

    // ---- 「假装被杀」：那条调用真开跑了，然后这个进程直接没了（不报结束）----
    // 验的是「结果永远回不来」那种调用在界面上长什么样：先转圈，等后端发现进程没了，
    // 转圈收掉、提示框里写「这一轮被中断，没有结果」（见 media/chat.js 的 settleInterruptedTools）。
    if (/假装被杀/.test(userText)) {
        await say("（假模型）我起一条 bash，然后这个进程就没了 —— 结果不会回来。");
        emit({
            type: "tool_execution_start",
            toolCallId: "call_killed",
            toolName: "bash",
            args: { command: "sleep 600" },
        });
        await sleep(2000);   // 留够时间看一眼那颗转圈的标签
        process.exit(1);
    }

    // ---- 「这个会话碰过的文件」那几种（验「链接里只有光名字也能打开」那票）----
    // 后端那份清单只从 read / edit / write 的工具调用里来，所以这里真去 read 几个文件
    //（内容后端不看，要的是那几个路径）。素材由 dev/fileSidebar.js 铺：
    //   - 子目录里藏一个（链接里只有光名字时，靠这份清单兜底找到它）；
    //   - 会话目录里、子目录里各放一个同名的（先按会话目录拼那一档该赢）；
    //   - outside/ 那颗指到会话目录外面的软链接里那一个（清单里匹配到了，边界也得挡住）。
    if (/碰文件/.test(userText)) {
        await say("（假模型）我读三个文件，把「这个会话碰过的文件」清单喂给后端。");
        for (const readPath of ["names/only-name.js", "names/two-places.js", "outside/package.json"]) {
            await act("read", { path: readPath }, {
                content: [{ type: "text", text: "Read " + readPath }],
                raw: { content: [{ type: "text", text: "Read " + readPath }] },
            });
        }
        await say("读完了。");
        finish();
        return;
    }

    // ---- 「写新文件」：write 工具真建一个文件（验「改动」那一格里整份都是新加的那种）----
    if (/写新文件/.test(userText)) {
        await say("（假模型）我新建一个文件。");
        await act("write", { path: "新文件.txt", content: NEW_FILE_TEXT }, {
            content: [{ type: "text", text: "已写入" }],
            raw: {
                content: [{ type: "text", text: "已写入" }],
                details: {
                    diff: NEW_FILE_TEXT.trimEnd().split("\n").map((l) => "+" + l).join("\n"),
                },
            },
        });
        await say("写完了。");
        finish();
        return;
    }

    await think(padTo("用户要的是演示，那就按老剧本走一遍：先读图，再 bash，再改一下文件。", LONG_TEXT_CHARS));
    await say("好，我用三个工具给你演示一遍（假模型秒回）：");    await act("read", { path: "示例图片.png" }, {
        content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: SAMPLE_PNG_BASE64, mimeType: "image/png" },
        ],
        raw: { content: [{ type: "text", text: "Read image file [image/png]" }], details: { dims: "10x10" } },
    });
    const bashText = padTo("示例.js\n示例图片.png\n说明.txt", LONG_TEXT_CHARS);
    await act("bash", { command: "ls" }, {
        content: [{ type: "text", text: bashText }],
        raw: { content: [{ type: "text", text: bashText }], exitCode: 0 },
    });
    await act("edit", { path: "说明.txt", oldText: "调试", newText: "调试（假模型改的）" }, {
        content: [{ type: "text", text: "已编辑" }],
        raw: {
            content: [{ type: "text", text: "已编辑" }],
            details: { diff: "--- 说明.txt\n+++ 说明.txt\n@@ -1 +1 @@\n-这是 Pi Chat 插件的调试用工作目录（dev/.scratch）。\n+这是 Pi Chat 插件的调试用工作目录（dev/.scratch）（假模型改的）。\n" },
        },
    });
    await say(padTo("完事。三个工具都跑过了：read（带图）、bash、edit。", REPLY_LONG_CHARS));
    finish();
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

const SCRIPT_FILE = "说明.txt";

/** 剧本里新建那个文件的内容（「写新文件」那一段用）。 */
const NEW_FILE_TEXT = "第一行\n第二行\n第三行\n";

/** edit / write 真去动那个文件：编辑卡片（diff）与「改动」那一格才有东西可看，回滚也有的滚。 */
function applyToolChange(toolName, args) {
    if (toolName !== "write") { applyFakeEdit(args); return; }
    try {
        const p = path.resolve(process.cwd(), args.path || "新文件.txt");
        fs.writeFileSync(p, typeof args.content === "string" ? args.content : "", "utf8");
    } catch { /* 写不进去就算了，剧本照演 */ }
}

/** edit 工具真的改文件（在原文里换掉一处）。 */
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
            void runScript(String(cmd.message || "")).catch((e) => {
                // 这一轮被 abort 打断：收尾事件剧本里已经发过了（见 pause），这里只是把这条链收干净
                if (e === ABORTED) { return; }
                console.error("[假 pi] 剧本跑岔了：" + String((e && e.stack) || e));
            });
            return;
        }
        case "get_state":
            respond(id, "get_state", {
                model: MODEL,
                thinkingLevel: "off",
                isStreaming: false,
                sessionFile,
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
        // 压缩：真 pi 会在压缩前后各发一条事件，然后直接回一个 response（不等模型，秒回）
        case "compact": {
            write({ type: "compaction_start", reason: "manual" });
            const result = {
                summary: "（假 pi 的压缩摘要" + (cmd.customInstructions ? "：" + cmd.customInstructions : "") + "）",
                firstKeptEntryId: "fake-kept-1",
                tokensBefore: 1000,
                estimatedTokensAfter: 320,
            };
            write({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
            respond(id, "compact", result);
            return;
        }
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
