// @ts-nocheck
/**
 * 验 bash 的可选输出通知，不调用模型。
 *
 * 会话部分用受控时间和假的 pi 连接，检查实际合并、发送和结束处理；
 * 生成的 bash 扩展配合假的 pi 工具接口，实际启动短命令，检查输出与退出。
 * 所有日志只落在 dev/.scratch/。先 npm run compile，再 node dev/bashOutput.js。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const protocol = require(path.join(root, "out/server/bashProtocol"));
const { SessionRuntime } = require(path.join(root, "out/server/sessionRuntime"));
const { ChatControllerBase } = require(path.join(root, "out/server/chatControllerBase"));
const { bashBridgeSource } = require(path.join(root, "out/server/bashBridgeSource"));

function checkRuntime() {
    const original = { now: Date.now, set: global.setTimeout, clear: global.clearTimeout };
    let now = 1794300000000;
    let seq = 0;
    const timers = new Map();
    Date.now = () => now;
    global.setTimeout = (cb, ms) => {
        const timer = { id: ++seq, unref() {} };
        timers.set(timer, { cb, at: now + ms });
        return timer;
    };
    global.clearTimeout = timer => timers.delete(timer);
    const advance = ms => {
        const until = now + ms;
        for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            timers.delete(next[0]);
            now = next[1].at;
            next[1].cb();
        }
        now = until;
    };
    const runtimes = [];
    function create(autoAccept = true) {
        const sent = [];
        const humanMessages = [];
        const controller = { panels: new Map(), getConfig: () => ({ prompts: {} }) };
        const runtime = new SessionRuntime("output-check", {}, {
            postToSession() {}, broadcastSessionList() {}, onTurnEnd() {},
            onUserMessage: id => humanMessages.push(id),
            onBashOutput: (id, tasks) => ChatControllerBase.prototype.onBashOutput.call(controller, id, tasks),
            onBashTask: (id, task) => ChatControllerBase.prototype.onBashTask.call(controller, id, task),
        });
        runtime.client = { isRunning: () => true, send: cmd => {
            sent.push(cmd);
            if (autoAccept && cmd.type === "prompt") runtime.onPiResponse({ id: cmd.id, command: "prompt", success: true, data: { disposition: "started" } });
        }, stop() {}, request: async () => undefined };
        runtime.cachedCommands = [];
        runtime.getLastAssistantText = async () => "";
        runtime.refreshStats = async () => {};
        controller.panels.set(runtime.id, runtime);
        runtimes.push(runtime);
        const start = no => runtime.noteBashTask({ kind: "start", no, toolCallId: "c" + no, cmd: "check-" + no, log: "missing-check.log", background: true, startedAt: now, notifyOutput: true });
        const output = (no, text) => runtime.noteBashTask({ kind: "output", no, toolCallId: "c" + no, cmd: "check-" + no, log: "missing-check.log", background: true, output: { text, firstAt: now, lastAt: now } });
        const end = (no, extra) => runtime.noteBashTask({ kind: "end", no, toolCallId: "c" + no, cmd: "check-" + no, log: "missing-check.log", background: true, status: "done", exitCode: 0, elapsedMs: 60000, ...extra });
        return { runtime, sent, humanMessages, start, output, end };
    }
    try {
        const busy = create();
        busy.start(1);
        busy.runtime.streaming = true;
        for (let i = 0; i < 60; i++) { busy.output(1, i + "s 进度\n"); advance(1000); }
        assert.equal(busy.sent.length, 0);
        busy.runtime.onPiEvent({ type: "agent_end" });
        advance(3000);
        assert.equal(busy.sent.length, 0, "agent_end 不是空闲");
        busy.runtime.onPiEvent({ type: "agent_settled" });
        advance(300);
        assert.equal(busy.sent.length, 1);
        assert(busy.sent[0].message.includes("0s 进度") && busy.sent[0].message.includes("59s 进度"));
        assert(busy.sent[0].message.includes("输出观察时间"));
        busy.output(1, "新一批\n");
        advance(10000);
        assert.equal(busy.sent.length, 1, "prompt 发出后、agent_start 前也不能再发");
        assert.equal(busy.humanMessages.length, 0, "自动输出不是用户说话");
        busy.runtime.stopClient();

        const multi = create();
        multi.start(2); multi.start(3);
        multi.output(2, "READY-2\n"); multi.output(3, "READY-3\n");
        advance(300);
        assert.equal(multi.sent.length, 1, "多个命令合成一个 prompt");
        assert(multi.sent[0].message.includes("READY-2") && multi.sent[0].message.includes("READY-3"));
        multi.runtime.onPiEvent({ type: "agent_settled" });
        multi.output(2, "next\n");
        advance(1999);
        assert.equal(multi.sent.length, 1);
        advance(1);
        assert.equal(multi.sent.length, 2, "通知至少间隔两秒");
        multi.runtime.onPiEvent({ type: "agent_settled" });
        advance(10000);
        assert.equal(multi.sent.length, 2, "没有新输出就不重复叫模型");
        multi.runtime.stopClient();

        const terminal = create();
        terminal.start(4);
        terminal.runtime.streaming = true;
        terminal.output(4, "尚未交回的进度\n");
        terminal.end(4, { output: { text: "最后输出😀\n", firstAt: now, lastAt: now } });
        terminal.end(4);
        terminal.output(4, "已经结束后的旧输出\n");
        assert.equal(terminal.sent.length, 1);
        assert(terminal.sent[0].message.includes("跑完了") && terminal.sent[0].message.includes("尚未交回的进度") && terminal.sent[0].message.includes("最后输出😀"));
        terminal.runtime.onPiEvent({ type: "agent_settled" });
        advance(10000);
        assert.equal(terminal.sent.length, 1, "结束后不能再重放旧进度");
        assert.equal(terminal.runtime.listBashTasks()[0].output, undefined, "完成输出不在任务清单里重复保存");
        terminal.runtime.stopClient();

        const early = create();
        early.start(5); early.output(5, "还没发出的输出\n"); early.end(5);
        advance(3000);
        assert.equal(early.sent.length, 1, "合批计时器触发前结束，应只有完成通知");
        assert(early.sent[0].message.includes("还没发出的输出"));
        early.runtime.stopClient();

        const compact = create();
        compact.start(6); compact.runtime.compacting = true; compact.output(6, "压缩时的输出\n");
        advance(3000);
        assert.equal(compact.sent.length, 0);
        compact.runtime.noteSessionReplaced(); compact.runtime.compacting = false;
        advance(3000);
        assert.equal(compact.sent.length, 0, "换会话后旧输出清掉");
        compact.runtime.stopClient();

        const queued = create();
        queued.start(8);
        queued.runtime.onPiEvent({ type: "queue_update", steering: [], followUp: ["已有排队消息"] });
        queued.output(8, "等排队消息处理后再交回\n");
        advance(3000);
        assert.equal(queued.sent.length, 0);
        queued.runtime.onPiEvent({ type: "queue_update", steering: [], followUp: [] });
        advance(300);
        assert.equal(queued.sent.length, 1, "排队消息清空后还能交回已经攒的输出");
        queued.runtime.stopClient();

        const several = create();
        for (let no = 9; no <= 14; no++) { several.start(no); several.output(no, "TASK-" + no + "\n"); }
        advance(300);
        assert.equal(several.sent.length, 1);
        assert(several.sent[0].message.includes("TASK-12") && !several.sent[0].message.includes("TASK-13"));
        several.runtime.onPiEvent({ type: "agent_settled" });
        advance(2000);
        assert.equal(several.sent.length, 2);
        assert(several.sent[1].message.includes("TASK-13") && several.sent[1].message.includes("TASK-14"));
        several.runtime.stopClient();

        const handled = create(false);
        handled.start(15); handled.runtime.handleSend("/handled"); handled.output(15, "处理器接手后仍能通知\n");
        handled.runtime.onPiResponse({ id: handled.sent[0].id, command: "prompt", success: true, data: { disposition: "handled" } });
        advance(300);
        assert.equal(handled.sent.length, 2);
        handled.runtime.stopClient();

        const rejected = create(false);
        rejected.start(16); rejected.runtime.handleSend("rejected"); rejected.output(16, "请求失败后仍能通知\n");
        rejected.runtime.onPiResponse({ id: rejected.sent[0].id, command: "prompt", success: false, error: "rejected" });
        advance(300);
        assert.equal(rejected.sent.length, 2);
        rejected.runtime.stopClient();

        const inFlight = create(false);
        inFlight.start(17); inFlight.runtime.handleSend("正在接受的新请求"); inFlight.runtime.handleSend("/handled");
        inFlight.runtime.onPiResponse({ id: inFlight.sent[1].id, command: "prompt", success: true, data: { disposition: "handled" } });
        inFlight.runtime.onPiEvent({ type: "agent_settled" });
        inFlight.output(17, "不能被上一轮结束或另一个handled响应放行\n");
        advance(3000);
        assert.equal(inFlight.sent.length, 2);
        inFlight.runtime.onPiResponse({ id: inFlight.sent[0].id, command: "prompt", success: true, data: { disposition: "started" } });
        inFlight.runtime.onPiEvent({ type: "agent_start" });
        inFlight.runtime.onPiEvent({ type: "agent_settled" });
        advance(300);
        assert.equal(inFlight.sent.length, 3);
        inFlight.runtime.stopClient();

        const replay = create();
        replay.start(18); replay.output(18, "REPORTED-READY\n"); advance(300);
        replay.runtime.onPiEvent({ type: "agent_settled" });
        const scratch = path.join(__dirname, ".scratch");
        fs.mkdirSync(scratch, { recursive: true });
        const log = path.join(scratch, "bash-output-already-notified.log");
        fs.writeFileSync(log, "REPORTED-READY\n");
        replay.end(18, { log });
        assert.equal(replay.sent.length, 2);
        assert(!replay.sent[1].message.includes("REPORTED-READY"), "没有剩余新输出时不退回读取旧日志");
        replay.runtime.stopClient();

        const stopFailed = create();
        stopFailed.start(19);
        stopFailed.runtime.bashTasks.get(19).pid = Number.MAX_SAFE_INTEGER;
        assert.equal(stopFailed.runtime.stopBashTask(19), false);
        assert.equal(stopFailed.runtime.bashTasks.get(19).status, "running");
        stopFailed.output(19, "停止失败后继续通知\n"); advance(300);
        assert.equal(stopFailed.sent.length, 1);
        stopFailed.runtime.stopClient();

        const bounded = create();
        bounded.start(7); bounded.runtime.streaming = true;
        let length = 0;
        for (let i = 0; i < 100; i++) {
            const text = (i === 0 ? "HEAD😀" : "") + "a😀".repeat(1000) + (i === 99 ? "LATEST😀" : "");
            length += text.length; bounded.output(7, text);
        }
        const retained = bounded.runtime.bashOutputPending.get(7);
        assert(retained.text.length <= protocol.BASH_OUTPUT_MAX_CHARS);
        assert(retained.text.startsWith("HEAD😀") && retained.text.endsWith("LATEST😀"));
        assert.equal(retained.text.length + retained.omittedChars, length);
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(retained.text));
        bounded.runtime.stopClient();
        assert.equal(timers.size, 0);
        console.log("通过：忙时60批合成一次、多命令合并、发送前的空隙、两秒限频、结束合并、清理、压缩和输出长度上限。");
    } finally {
        for (const runtime of runtimes) runtime.stopClient();
        Date.now = original.now; global.setTimeout = original.set; global.clearTimeout = original.clear;
    }
}

async function checkBridge() {
    const scratch = path.join(__dirname, ".scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const work = fs.mkdtempSync(path.join(scratch, "bash-output-"));
    const tools = new Map();
    const frames = [];
    const waiting = [];
    const env = { ...process.env, PI_CODING_AGENT_DIR: work, PICHAT_BASH_DIR: path.join(work, "bash"), PICHAT_BASH_FOREGROUND_MS: "0" };
    let failStop = false;
    const childProcess = require("node:child_process");
    const fakeProcess = Object.create(process);
    Object.defineProperty(fakeProcess, "kill", { value: (pid, signal) => {
        if (failStop) throw new Error("模拟停止失败");
        return process.kill(pid, signal);
    } });
    Object.defineProperty(fakeProcess, "env", { value: env });
    Object.defineProperty(fakeProcess, "cwd", { value: () => work });
    Object.defineProperty(fakeProcess, "stderr", { value: { write(line) {
        const frame = protocol.decodeBashFrame(String(line).trim());
        assert(frame, "输出暗号必须能解析");
        frames.push(frame);
        for (const item of [...waiting]) if (item.match(frame)) { waiting.splice(waiting.indexOf(item), 1); item.resolve(frame); }
        return true;
    } } });
    const sdk = {
        getShellConfig: () => ({ shell: process.execPath, args: ["-e"] }),
        createBashTool: (cwd, { operations }) => ({ name: "bash", description: "test", async execute(id, params) {
            const chunks = [];
            const result = await operations.exec(params.command, cwd, { timeout: params.timeout, onData: chunk => chunks.push(chunk) });
            return { content: [{ type: "text", text: Buffer.concat(chunks).toString("utf8") }], details: { exitCode: result.exitCode } };
        } }),
    };
    const invalid = { kind: "output", no: 1, toolCallId: "bad", cmd: "bad", log: "bad.log", background: true, output: { text: "bad", firstAt: 0, lastAt: 1e20 } };
    assert.equal(protocol.normalizeBashTaskEvent(invalid), undefined, "无效时间不能导致消息格式化崩溃");
    const source = bashBridgeSource();
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} };
    vm.runInNewContext(js, { module: mod, exports: mod.exports, require: name => name === "@earendil-works/pi-coding-agent" ? sdk : name === "node:child_process" ? {
        ...childProcess, spawnSync: (...args) => failStop && args[0] === "taskkill" ? { status: 1 } : childProcess.spawnSync(...args),
    } : require(name), process: fakeProcess, Buffer, setTimeout, clearTimeout, setInterval, clearInterval });
    mod.exports.default({ on() {}, registerTool: tool => tools.set(tool.name, tool) });
    assert.deepEqual([...tools.keys()], ["bash", "bash_tasks"]);
    assert.equal(tools.get("bash").parameters.properties.notifyOutput.type, "boolean");
    const call = (id, params) => tools.get("bash").execute(id, params);
    const until = match => {
        const prior = frames.find(match);
        if (prior) return Promise.resolve(prior);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("没有等到命令输出或结束")), 8000);
            waiting.push({ match, resolve: frame => { clearTimeout(timer); resolve(frame); } });
        });
    };
    const ended = no => until(frame => frame.no === no && frame.kind === "end");
    try {
        const ordinary = await call("ordinary", { command: 'console.log("ordinary");setTimeout(()=>console.log("ordinary-end"),700)', background: true });
        await ended(ordinary.details.backgroundNo);
        assert.deepEqual(frames.filter(f => f.no === ordinary.details.backgroundNo).map(f => f.kind), ["start", "end"], "默认不开输出通知");

        const foreground = await call("foreground", { command: 'console.log("foreground");setTimeout(()=>console.log("foreground-end"),700)', notifyOutput: true });
        assert(foreground.content[0].text.includes("foreground-end"));
        assert(!frames.some(f => f.toolCallId === "foreground"), "前台不重复通知");

        const enabled = await call("enabled", { command: 'console.log("READY😀");console.error("错误😀");setTimeout(()=>console.log("FINAL😀"),700)', background: true, notifyOutput: true });
        const final = await ended(enabled.details.backgroundNo);
        const progress = frames.filter(f => f.no === final.no && f.kind === "output");
        assert(progress.length > 0 && progress.some(f => f.output.text.includes("READY😀")));
        assert(final.output.text.includes("FINAL😀"), "最后输出和end一起交回");
        assert(fs.readFileSync(final.log, "utf8").includes("错误😀"));
        assert.equal(frames.filter(f => f.no === final.no && f.kind === "end").length, 1);

        const quiet = await call("quiet-end", { command: 'console.log("NOTIFIED-ONCE");setTimeout(()=>{},900)', background: true, notifyOutput: true });
        const quietEnd = await ended(quiet.details.backgroundNo);
        assert(frames.some(f => f.no === quietEnd.no && f.kind === "output"));
        assert.equal(quietEnd.notifyOutput, true);
        assert.equal(quietEnd.output, undefined, "没有剩余输出也保留开启通知的标记");
        assert(!protocol.buildBashTaskDelivery({ ...quietEnd, tail: "OLD-LOG-SHOULD-NOT-BE-REPLAYED" }).includes("OLD-LOG-SHOULD-NOT-BE-REPLAYED"));

        const pipes = await call("pipes-open", { command: 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>console.log(123),1500)"],{stdio:"inherit",detached:true,windowsHide:true}).unref()', background: true, notifyOutput: true });
        const pipesEnd = await ended(pipes.details.backgroundNo);
        assert(pipesEnd.output.text.includes("输出管道尚未关闭"), "后代持有管道时也必须有明确收场");

        const fast = await call("fast", { command: 'process.stdout.write("FAST😀")', background: true, notifyOutput: true });
        const fastEnd = await ended(fast.details.backgroundNo);
        assert(!frames.some(f => f.no === fastEnd.no && f.kind === "output"));
        assert(fastEnd.output.text.includes("FAST😀"), "没换行的尾部也保留");

        const split = await call("split", { command: 'const b=Buffer.from("中文😀");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)', background: true, notifyOutput: true });
        const splitEnd = await ended(split.details.backgroundNo);
        assert.equal(splitEnd.output.text, "中文😀");

        const large = await call("large", { command: 'process.stdout.write("H"+"😀".repeat(5000)+"T");setTimeout(()=>process.stdout.write("X"),30)', background: true, notifyOutput: true });
        const largeEnd = await ended(large.details.backgroundNo);
        assert(largeEnd.output.text.length <= protocol.BASH_OUTPUT_MAX_CHARS);
        assert.equal(largeEnd.output.text.length + largeEnd.output.omittedChars, 10003);
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(largeEnd.output.text));

        const failed = await call("failure", { command: 'console.error("failure-output");process.exit(7)', background: true, notifyOutput: true });
        const failureEnd = await ended(failed.details.backgroundNo);
        assert.equal(failureEnd.status, "failed");
        assert.equal(failureEnd.exitCode, 7);
        assert(failureEnd.output.text.includes("failure-output"));

        const timeout = await call("timeout", { command: 'setInterval(()=>console.log("timeout-output"),100)', background: true, notifyOutput: true, timeout: 0.7 });
        const timeoutEnd = await ended(timeout.details.backgroundNo);
        assert.notEqual(timeoutEnd.status, "running");
        assert.equal(frames.filter(f => f.no === timeoutEnd.no && f.kind === "end").length, 1);

        env.PICHAT_BASH_FOREGROUND_MS = "30";
        const budget = await call("budget", { command: 'console.log("budget-start");setTimeout(()=>console.log("budget-progress"),100);setTimeout(()=>console.log("budget-end"),900)', notifyOutput: true });
        await ended(budget.details.backgroundNo);
        assert(frames.some(f => f.no === budget.details.backgroundNo && f.kind === "output"));

        env.PICHAT_BASH_FOREGROUND_MS = "0";
        const manualRun = call("manual", { command: 'console.log("manual-front");setTimeout(()=>console.log("manual-back"),800)', notifyOutput: true });
        fs.writeFileSync(path.join(env.PICHAT_BASH_DIR, "detach/manual"), "");
        const manual = await manualRun;
        const manualEnd = await ended(manual.details.backgroundNo);
        assert(manualEnd.output.text.includes("manual-back"));

        const live = await call("stop", { command: 'setInterval(()=>console.log("running"),100)', background: true, notifyOutput: true });
        await until(f => f.no === live.details.backgroundNo && f.kind === "output");
        failStop = true;
        const refused = await tools.get("bash_tasks").execute("stop-failed", { id: live.details.backgroundNo, stop: true });
        assert.equal(refused.details.error, "stop failed");
        assert.equal(refused.details.status, "running");
        const afterRefused = frames.length;
        await until(f => frames.indexOf(f) >= afterRefused && f.no === live.details.backgroundNo && f.kind === "output");
        failStop = false;
        await tools.get("bash_tasks").execute("stop", { id: live.details.backgroundNo, stop: true });
        assert.equal((await ended(live.details.backgroundNo)).status, "stopped");
        assert.equal(frames.filter(f => f.no === live.details.backgroundNo && f.kind === "end").length, 1);
        console.log("通过：生成扩展只有bash/bash_tasks；默认不通知、前台不重复、后台有新输出、结束不重放旧输出、中文跨块与截取、后代持有管道、失败、超时、手动和自动转后台、停止失败继续通知且能重试。");
    } finally {
        failStop = false;
        const list = await tools.get("bash_tasks").execute("list", {});
        for (const task of list.details.tasks || []) if (task.status === "running") await tools.get("bash_tasks").execute("cleanup", { id: task.id, stop: true });
    }
}

(async () => {
    checkRuntime();
    let deadline;
    try {
        await Promise.race([
            checkBridge(),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("生成扩展检查没有全部跑完")), 20000); }),
        ]);
    } finally { clearTimeout(deadline); }
})().catch(error => { console.error(error); process.exitCode = 1; });
