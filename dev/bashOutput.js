// @ts-nocheck
/**
 * 后台命令通知：不调用真模型。
 * 受控进程/时间验排队期间更新、结束升级、去重与清理；真实 SDK 的检查在文件末尾。
 * 日志与临时文件只放 dev/.scratch/。npm run compile && node dev/bashOutput.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { findPackageJSON } = require('node:module');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const protocol = require(path.join(root, 'out/server/bashProtocol'));
const { bashBridgeSource } = require(path.join(root, 'out/server/bashBridgeSource'));
const { SessionRuntime, commandMenuItems } = require(path.join(root, 'out/server/sessionRuntime'));
const scratch = path.join(__dirname, '.scratch');
fs.mkdirSync(scratch, { recursive: true });

function bridgeModule(sdk, processShim, childProcess, timers) {
    const source = bashBridgeSource();
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} };
    vm.runInNewContext(js, {
        module: mod, exports: mod.exports, Buffer,
        require: name => name === '@earendil-works/pi-coding-agent' ? sdk : name === 'node:child_process' && childProcess ? childProcess : require(name),
        process: processShim,
        Date: timers?.Date || Date,
        setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout,
        setInterval: timers?.setInterval || setInterval, clearInterval: timers?.clearInterval || clearInterval,
    });
    return mod.exports.default;
}

function fixture(options = {}) {
    const work = fs.mkdtempSync(path.join(scratch, 'bash-notice-'));
    let now = 1794300000000;
    let nextTimer = 0;
    let idle = true;
    let killStatus = 0;
    let started = false;
    const timers = new Map();
    const children = [];
    const hooks = new Map();
    const tools = new Map();
    const commands = new Map();
    const notices = [];
    const frames = [];
    function addTimer(cb, ms, interval) {
        const token = { id: ++nextTimer, unref() {} };
        timers.set(token, { cb, at: now + ms, interval });
        return token;
    }
    const time = {
        Date: class extends Date { static now() { return now; } },
        setTimeout: (cb, ms) => addTimer(cb, ms, 0), clearTimeout: id => timers.delete(id),
        setInterval: (cb, ms) => addTimer(cb, ms, ms), clearInterval: id => timers.delete(id),
    };
    function advance(ms) {
        const until = now + ms;
        for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            if (next[1].interval) next[1].at += next[1].interval;
            else timers.delete(next[0]);
            next[1].cb();
        }
        now = until;
    }
    const ctx = { cwd: work, isIdle: () => idle, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => undefined } };
    const pi = {
        on(name, handler) { const list = hooks.get(name) || []; list.push(handler); hooks.set(name, list); return () => {}; },
        registerTool: tool => tools.set(tool.name, tool),
        registerCommand: (name, command) => commands.set(name, command),
        sendMessage(message, deliveryOptions) {
            assert.equal(message.customType, protocol.BASH_NOTICE_TYPE);
            assert.equal(message.display, false);
            assert.equal(message.details.ready, false);
            notices.push({ role: 'custom', ...message });
            if (!options.keepIdleAfterSend) idle = false;
        },
        clearQueue() { throw new Error('不能清空用户队列'); },
    };
    const fakeProcess = Object.create(process);
    Object.defineProperties(fakeProcess, {
        platform: { value: 'win32' }, cwd: { value: () => work },
        env: { value: { ...process.env, PI_CODING_AGENT_DIR: work, PICHAT_BASH_DIR: path.join(work, 'bash'), PICHAT_BASH_FOREGROUND_MS: '0' } },
        stderr: { value: { write(line) { const ev = protocol.decodeBashFrame(String(line).trim()); assert(ev); assert(['start', 'end'].includes(ev.kind)); frames.push(ev); return true; } } },
    });
    const childProcess = {
        spawn() {
            const child = new EventEmitter();
            child.pid = 1000 + children.length;
            child.stdin = new EventEmitter(); child.stdin.end = () => {};
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
            children.push(child);
            return child;
        },
        spawnSync: () => ({ status: killStatus }),
    };
    const sdk = {
        getShellConfig: () => ({ shell: 'fake-shell', args: ['-c'] }),
        createBashTool: (cwd, { operations }) => ({ name: 'bash', description: 'fake', async execute(_id, params) {
            const chunks = [];
            const result = await operations.exec(params.command, cwd, { timeout: params.timeout, onData: chunk => chunks.push(chunk) });
            return { content: [{ type: 'text', text: Buffer.concat(chunks).toString('utf8') }], details: { exitCode: result.exitCode } };
        } }),
    };
    bridgeModule(sdk, fakeProcess, childProcess, time)(pi);
    const fire = async (name, event = {}) => {
        let replacement;
        for (const handler of hooks.get(name) || []) {
            const result = await handler(event, ctx);
            if (result?.message) { event.message = result.message; replacement = result.message; }
        }
        return replacement;
    };
    return {
        tools, commands, notices, frames, work, ctx, advance, fire,
        setIdle: value => { idle = value; }, setKillStatus: value => { killStatus = value; },
        async start(params = {}) {
            if (!started) { started = true; await fire('session_start', { reason: 'startup' }); }
            const result = await tools.get('bash').execute('c' + children.length, { command: 'collect', background: true, notifyOutput: true, ...params }, undefined, undefined, ctx);
            const child = children[children.length - 1];
            return { result, child, output(text) { child.stdout.emit('data', Buffer.from(text)); }, finish(code = 0) { child.closed = true; child.emit('exit', code); child.emit('close', code); } };
        },
        async consume(index = notices.length - 1) {
            const message = notices[index];
            assert(message);
            const replacement = await fire('message_end', { message });
            if (replacement) Object.assign(message, replacement);
            assert.doesNotThrow(() => JSON.stringify(message));
            return message;
        },
        async settled() { idle = true; await fire('agent_settled', { aborted: false }); },
        async dispose() {
            await fire('session_shutdown', { reason: 'quit' });
            for (const child of children) if (!child.closed) { child.closed = true; child.emit('exit', 0); child.emit('close', 0); }
        },
    };
}

async function checkQueued() {
    const f = fixture();
    const job = await f.start();
    assert.deepEqual([...f.tools.keys()], ['bash', 'bash_tasks']);
    job.output('READY\n'); f.advance(3000);
    assert.equal(f.notices.length, 1);
    assert(!f.notices[0].content.includes('READY'), '排队时不保存过时的输出正文');
    job.output('UPDATED\n'); f.advance(3000);
    assert.equal(f.notices.length, 1, '排队期间只更新数据，不再加消息');
    job.output('FINAL\n'); job.finish(); f.advance(3000);
    assert.equal(f.notices.length, 1, '结束升级同一条通知');
    f.advance(100000);
    const done = await f.consume();
    assert(protocol.isBashNoticeMessage(done));
    assert(done.content.includes('跑完了') && done.content.includes('READY') && done.content.includes('UPDATED') && done.content.includes('FINAL'));
    assert(!done.content.includes('用了 1 分'), '结束耗时不能包含排队等待');
    await f.settled(); f.advance(5000);
    assert.equal(f.notices.length, 1, '已交回的结束结果不能重复通知');
    await f.dispose();

    const busy = fixture();
    const work = await busy.start(); busy.setIdle(false);
    for (let i = 0; i < 60; i++) { work.output(i + 's\n'); busy.advance(1000); }
    assert.equal(busy.notices.length, 0);
    await busy.settled(); busy.advance(3000);
    assert.equal(busy.notices.length, 1);
    const progress = await busy.consume();
    assert(progress.content.includes('0s') && progress.content.includes('59s'));
    const read = progress.content;
    work.output('later\n'); work.finish(); busy.advance(3000);
    assert.equal(progress.content, read, '不能改模型已经读过的通知');
    assert.equal(busy.notices.length, 2);
    await busy.consume(); await busy.dispose();

    const plain = fixture();
    const defaultJob = await plain.start({ notifyOutput: false });
    defaultJob.output('ordinary-result\n'); plain.advance(3000);
    assert.equal(plain.notices.length, 0);
    defaultJob.finish(); plain.advance(3000);
    assert.equal(plain.notices.length, 1);
    fs.writeFileSync(plain.frames.find(ev => ev.kind === 'end').log, 'OVERWRITTEN-LATER');
    const ordinary = await plain.consume();
    assert(ordinary.content.includes('ordinary-result') && !ordinary.content.includes('OVERWRITTEN-LATER'));
    await plain.dispose();

    const bound = fixture();
    const long = await bound.start();
    long.output('HEAD😀' + 'a😀'.repeat(100000) + 'TAIL😀'); bound.advance(3000);
    const bounded = await bound.consume();
    assert(bounded.content.includes('HEAD😀') && bounded.content.includes('TAIL😀') && bounded.content.includes('省略'));
    assert(bounded.content.length < 6000);
    const original = { role: 'user', customType: protocol.BASH_NOTICE_TYPE, details: { ...bounded.details, ready: false }, content: [{ type: 'text', text: 'USER-DIRECTIVE' }, { type: 'image', data: 'user-image', mimeType: 'image/png' }] };
    const copy = structuredClone(original);
    assert.equal(await bound.fire('message_end', { message: original }), undefined);
    assert.deepEqual(structuredClone(original), copy, '不能修改用户消息及图片');
    const foreign = { ...original, role: 'custom', customType: 'another-extension' };
    assert.equal(await bound.fire('message_end', { message: foreign }), undefined);
    await bound.dispose();

    const stop = fixture();
    const live = await stop.start(); live.output('running\n'); stop.advance(3000);
    stop.setKillStatus(1);
    assert.equal((await stop.tools.get('bash_tasks').execute('stop', { id: live.result.details.backgroundNo, stop: true })).details.error, 'stop failed');
    live.output('still-running\n'); stop.advance(3000);
    assert.equal(stop.notices.length, 1);
    stop.setKillStatus(0);
    await stop.tools.get('bash_tasks').execute('stop', { id: live.result.details.backgroundNo, stop: true });
    live.finish(1); stop.advance(3000);
    assert((await stop.consume()).content.includes('被停掉了'));
    await stop.dispose();

    const multiple = fixture();
    for (let i = 1; i <= 6; i++) { const part = await multiple.start(); part.output('TASK-' + i + '\n'); }
    multiple.advance(3000); assert.equal(multiple.notices.length, 1);
    const firstBatch = await multiple.consume();
    assert(firstBatch.content.includes('TASK-4') && !firstBatch.content.includes('TASK-5'));
    await multiple.settled(); multiple.advance(1999); assert.equal(multiple.notices.length, 1);
    multiple.advance(1); assert.equal(multiple.notices.length, 2);
    const secondBatch = await multiple.consume();
    assert(secondBatch.content.includes('TASK-5') && secondBatch.content.includes('TASK-6'));
    await multiple.dispose();

    const cancelled = fixture();
    const cancelledJob = await cancelled.start({ notifyOutput: false }); cancelled.setIdle(false);
    cancelledJob.output('after-abort-result\n'); cancelledJob.finish(); cancelled.advance(3000);
    assert.equal(cancelled.notices.length, 1);
    cancelled.setIdle(true); await cancelled.fire('agent_settled', { aborted: true }); cancelled.advance(10000);
    assert.equal(cancelled.notices.length, 1, '取消不等于custom队列已空，不能重发');
    assert((await cancelled.consume()).content.includes('after-abort-result'));
    await cancelled.dispose();

    const cleared = fixture();
    const clearedJob = await cleared.start(); clearedJob.output('CANCELLED-OUTPUT\n'); cleared.advance(3000);
    cleared.commands.get(protocol.BASH_CLEAR_NOTICE_COMMAND).handler('', cleared.ctx);
    await cleared.settled(); cleared.advance(3000); assert.equal(cleared.notices.length, 1);
    clearedJob.output('AFTER-CLEAR-OUTPUT\n'); cleared.advance(3000); assert.equal(cleared.notices.length, 2);
    const fresh = await cleared.consume();
    assert(fresh.content.includes('AFTER-CLEAR-OUTPUT') && !fresh.content.includes('CANCELLED-OUTPUT'));
    await cleared.dispose();

    const deferred = fixture({ keepIdleAfterSend: true });
    const deferredJob = await deferred.start(); deferredJob.output('deferred\n'); deferred.advance(3000);
    assert.equal(deferred.ctx.isIdle(), true, '真正模拟SDK延后发送时尚未开回复');
    assert.equal(deferred.notices.length, 1);
    await deferred.fire('agent_settled', { aborted: false }); deferred.advance(10000);
    assert.equal(deferred.notices.length, 1, '尚未开始的延后通知不能被当成发送失败重排');
    deferred.setIdle(false); await deferred.consume(); await deferred.dispose();

    const shutdown = fixture();
    const old = await shutdown.start(); old.output('old\n'); shutdown.advance(3000);
    await shutdown.dispose();
    old.output('after-close\n'); old.finish(); shutdown.advance(10000);
    assert.equal(shutdown.notices.length, 1, '会话关闭后不再派发通知');
    console.log('通过：排队期间更新、结束升级同一条、已读内容不改、忙时合并、默认完成通知、长度上限、不碰用户/图片、停止失败和关闭清理。');
}

function checkDisplay() {
    const events = [];
    const runtime = new SessionRuntime('notice-display', {}, { postToSession(_id, event) { events.push(event); }, broadcastSessionList() {}, onTurnEnd() {} });
    runtime.refreshStatsSoon = () => {};
    const pending = { role: 'custom', customType: protocol.BASH_NOTICE_TYPE, content: 'not-final', display: false, details: { owner: 'display-owner', noticeId: 1, ready: false } };
    runtime.onPiEvent({ type: 'message_start', message: pending });
    runtime.onPiEvent({ type: 'message_end', message: pending });
    assert(!events.some(event => event.type === 'userMessage'));
    const final = { ...pending, content: 'FINAL-CONTENT', display: true, details: { ...pending.details, ready: true } };
    runtime.onPiEvent({ type: 'message_end', message: final });
    const live = events.find(event => event.type === 'userMessage');
    assert.equal(live.text, final.content);
    events.length = 0;
    runtime.renderMessages([pending, final], { sink: event => events.push(event) });
    const history = events.filter(event => event.type === 'userMessage');
    assert.equal(history.length, 1);
    assert.equal(history[0].text, live.text);
    assert.equal(history[0].id, live.id);
    assert(runtime.hasConversation);
    assert.equal(runtime.sliceLastRound([pending, final]).start, 1);
    const sent = [];
    runtime.client = { isRunning: () => true, send: command => sent.push(command), stop() {} };
    runtime.streaming = true;
    runtime.noteBashTask({kind:'start',no:1,toolCallId:'display-task',cmd:'display-task',log:'display.log',background:true});
    runtime.abortActiveRun();
    assert.deepEqual(sent.map(command => command.type), ['abort_bash', 'clear_queue', 'prompt', 'abort']);
    assert.equal(sent[2].message, '/' + protocol.BASH_CLEAR_NOTICE_COMMAND);
    assert(!commandMenuItems([{name:protocol.BASH_CLEAR_NOTICE_COMMAND,source:'extension'}]).some(command=>command.insert==='/' + protocol.BASH_CLEAR_NOTICE_COMMAND));
    runtime.stopClient();
    console.log('通过：排队占位不显示；当场、历史重放和稳定编号一致，通知参与历史窗口；界面清空后的内部信号不出现在命令菜单。');
}

// 真 SDK 排队检查由下方 checkSdk 实现；没有网络模型调用。
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
async function bounded(promise, label, ms = 10000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
    finally { clearTimeout(timer); }
}
function contentText(content) {
    return typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function noticeFields(message) {
    return structuredClone({ role: message.role, customType: message.customType, content: message.content, display: message.display, details: message.details });
}
async function waitLog(file, text, action) {
    let check;
    const changed = new Promise(resolve => {
        check = () => { try { if (fs.readFileSync(file, 'utf8').split(/\r?\n/).includes(text)) resolve(); } catch {} };
        // Windows 的 fs.watch 可能要等写入句柄关闭才报变化；按文件大小变化检查真实输出。
        fs.watchFile(file, { interval: 50 }, check);
        action(); check();
    });
    try { await bounded(changed, '没有收到真实命令的新输出'); } finally { fs.unwatchFile(file, check); }
}
async function checkSdk() {
    let sdkRoot;
    try { sdkRoot = path.dirname(path.dirname(require.resolve('@earendil-works/pi-coding-agent'))); } catch {}
    if (!sdkRoot && process.env.APPDATA) sdkRoot = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
    if (!sdkRoot || !fs.existsSync(path.join(sdkRoot, 'dist/index.js'))) {
        const globalRoot = require('node:child_process').execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
        sdkRoot = path.join(globalRoot, '@earendil-works/pi-coding-agent');
    }
    const sdkUrl = pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href;
    const sdk = await import(sdkUrl);
    const aiPackage = findPackageJSON('@earendil-works/pi-ai', sdkUrl);
    assert(aiPackage, '需要 SDK 自己的 pi-ai');
    const ai = await import(pathToFileURL(path.join(path.dirname(aiPackage), 'dist/index.js')).href);
    for (const scenario of [{ finish: false }, { finish: true }, { finish: true, abort: true }]) {
        const finishBeforeRead = scenario.finish;
        const queueMode = scenario.abort ? 'one-at-a-time' : 'all';
        const work = fs.mkdtempSync(path.join(scratch, 'sdk-notice-'));
        const latestFile = path.join(work, 'latest');
        const finishFile = path.join(work, 'finish');
        const initialNotice = deferred();
        const firstRequest = deferred();
        const streamGate = deferred();
        const commandEnded = deferred();
        const completionRead = deferred();
        const frames = [];
        const publicEnds = [];
        const displayEvents = [];
        const requests = [];
        const extensionErrors = [];
        let held;
        let forward;
        let sendCount = 0;
        let session;
        let run;
        let job;
        let originalNow;
        const proc = Object.create(process);
        Object.defineProperties(proc, {
            cwd: { value: () => work },
            env: { value: { ...process.env, PI_CODING_AGENT_DIR: work, PICHAT_BASH_DIR: path.join(work, 'bash'), PICHAT_BASH_FOREGROUND_MS: '0' } },
            stderr: { value: { write(line) {
                const frame = protocol.decodeBashFrame(String(line).trim());
                assert(frame); frames.push(frame);
                if (frame.kind === 'end') commandEnded.resolve(frame);
                return true;
            } } },
        });
        const factory = bridgeModule(sdk, proc);
        const credentials = new ai.InMemoryCredentialStore();
        await credentials.modify('openai', async () => ({ type: 'api_key', key: 'offline-test-key' }));
        const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
        const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', steeringMode: queueMode, followUpMode: queueMode, images: { blockImages: false, autoResize: false } }, { projectTrusted: false });
        const loader = new sdk.DefaultResourceLoader({
            cwd: work, agentDir: work, settingsManager,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            systemPromptOverride: () => 'offline test', appendSystemPromptOverride: () => [],
            extensionFactories: [pi => {
                forward = pi.sendMessage.bind(pi);
                factory({ ...pi, sendMessage(message, options) {
                    assert.equal(message.customType, protocol.BASH_NOTICE_TYPE);
                    sendCount++;
                    if (!held) { held = { message, options }; initialNotice.resolve(); return; }
                    return forward(message, options);
                } });
            }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const model = { id: 'offline-test', name: 'offline-test', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        ({ session } = await sdk.createAgentSession({ cwd: work, agentDir: work, model, modelRuntime, thinkingLevel: 'off', resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(work), tools: ['bash', 'bash_tasks'] }));
        const display = new SessionRuntime('sdk-notice-display', {}, { postToSession(_id, event) { displayEvents.push(event); }, broadcastSessionList() {}, onTurnEnd() {} });
        display.refreshStatsSoon = () => {}; display.refreshStats = async () => {};
        display.getLastAssistantText = async () => '';
        session.subscribe(event => {
            display.onPiEvent(event);
            if (event.type === 'message_end') {
                const message = structuredClone(event.message);
                publicEnds.push(message);
                if (protocol.isBashNoticeMessage(message) && message.details.tasks?.some(t => t.status === 'done')) completionRead.resolve(message);
            }
        });
        session.agent.streamFunction = async (requestModel, context) => {
            const n = requests.push(structuredClone(context.messages));
            if (n === 1) { firstRequest.resolve(); await streamGate.promise; }
            const stream = new ai.AssistantMessageEventStream();
            const message = { role: 'assistant', content: [{ type: 'text', text: 'done-' + n }], api: requestModel.api, provider: requestModel.provider, model: requestModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
            stream.push({ type: 'start', partial: structuredClone(message) });
            stream.push({ type: 'done', reason: 'stop', message });
            return stream;
        };
        await session.bindExtensions({ onError: error => extensionErrors.push(error) });
        const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEUlEQVR4nGP8z0AswAKTQNYA' + 'AEGYAVfrEXvAAAAAAElFTkSuQmCC' };
        try {
            const bash = session.agent.state.tools.find(t => t.name === 'bash');
            assert(bash);
            const script = 'const fs=require("fs");console.log("READY-SDK");console.log("CWD-SDK="+process.cwd());let latest=false;const t=setInterval(()=>{if(!latest&&fs.existsSync("latest")){latest=true;console.log("LATEST-SDK")}if(latest&&fs.existsSync("finish")){clearInterval(t);console.log("FINAL-SDK")}},20)';
            const command = '"' + process.execPath.replace(/\\/g, '/') + '" -e ' + "'" + script + "'";
            job = await bash.execute('sdk-background', { command, background: true, notifyOutput: true }, new AbortController().signal, undefined);
            await bounded(initialNotice.promise, '没有首批通知');
            run = session.prompt('initial-user');
            await bounded(firstRequest.promise, '没有进入假生成边界');
            assert(session.isStreaming);
            forward(held.message, held.options);
            const queued = session.agent.peekQueuedMessages().find(m => m.role === 'custom' && m.customType === protocol.BASH_NOTICE_TYPE);
            assert(queued, '通知必须实际进入真实队列');
            const queuedText = queued.content;
            assert.equal(await session.steer('user-steer', [structuredClone(image)]), 'queued');
            assert.equal(await session.followUp('user-follow-up', [structuredClone(image)]), 'queued');
            session.sendCustomMessage({ customType: 'another-extension', content: 'FOREIGN-CUSTOM', display: true, details: { untouched: true } }, { triggerTurn: true, deliverAs: 'steer' });
            const log = frames.find(frame => frame.kind === 'start').log;
            await waitLog(log, 'LATEST-SDK', () => fs.writeFileSync(latestFile, 'go'));
            if (finishBeforeRead) { fs.writeFileSync(finishFile, 'go'); await bounded(commandEnded.promise, '命令没有结束'); }
            assert.deepEqual(session.getSteeringMessages(), ['user-steer']);
            assert.deepEqual(session.getFollowUpMessages(), ['user-follow-up']);
            assert.equal(sendCount, 1);
            assert.equal(queued.content, queuedText, '交回前只更新自己的数据，不改用户队列或提前填正文');
            if (scenario.abort) {
                const aborted = session.abort(); streamGate.resolve();
                await bounded(aborted, '取消没有收场'); await bounded(run, '取消没有收场');
                const stillQueued = session.agent.peekQueuedMessages().some(m => m.role === 'custom' && m.customType === protocol.BASH_NOTICE_TYPE);
                const alreadyDelivered = publicEnds.filter(protocol.isBashNoticeMessage);
                assert(stillQueued || alreadyDelivered.length === 1, '取消时通知只能保留或正常交回，不能丢失');
                assert.equal(sendCount, 1, '取消后不重发通知');
                if (stillQueued) run = session.prompt('after-abort-user');
            }
            originalNow = Date.now;
            Date.now = () => originalNow() + 100000;
            streamGate.resolve();
            await bounded(run, '假生成没有收场');
            Date.now = originalNow; originalNow = undefined;
            assert.deepEqual(extensionErrors, []);
            if (!scenario.abort) assert.equal(requests.length, 3);
            const own = publicEnds.filter(protocol.isBashNoticeMessage);
            assert.equal(own.length, 1);
            const message = own[0];
            assert(message.content.includes('\nREADY-SDK\n') && message.content.includes('\nLATEST-SDK\n'));
            assert.equal(message.content.includes('\nFINAL-SDK\n'), finishBeforeRead);
            assert.equal(message.content.includes('跑完了'), finishBeforeRead);
            const providerNotice = requests[1].find(m => m.role === 'user' && contentText(m.content) === message.content);
            assert(providerNotice, '真正的第二次生成必须看到替换后的内容');
            assert.deepEqual(providerNotice.content, [{ type: 'text', text: message.content }]);
            const current = session.messages.find(m => protocol.isBashNoticeMessage(m) && m.details.noticeId === message.details.noticeId);
            const history = session.sessionManager.buildSessionContext().messages.find(m => protocol.isBashNoticeMessage(m) && m.details.noticeId === message.details.noticeId);
            assert.deepEqual(noticeFields(current), noticeFields(message));
            assert.deepEqual(noticeFields(history), noticeFields(message));
            const shown = displayEvents.find(e => e.type === 'userMessage' && e.id === protocol.bashNoticeMessageId(message));
            assert.equal(shown.text, message.content);
            for (const label of ['user-steer', 'user-follow-up']) {
                const providerMessages = requests.find(messages => messages.some(m => m.role === 'user' && contentText(m.content) === label));
                assert(providerMessages);
                for (const messages of [providerMessages, publicEnds, session.messages, session.sessionManager.buildSessionContext().messages]) {
                    const user = messages.find(m => m.role === 'user' && contentText(m.content) === label);
                    assert(user);
                    assert.deepEqual(user.content, [{ type: 'text', text: label }, image]);
                }
            }
            assert(session.messages.some(m => m.role === 'custom' && m.customType === 'another-extension' && m.content === 'FOREIGN-CUSTOM' && m.details.untouched));
            if (finishBeforeRead) {
                const end = await commandEnded.promise;
                assert.equal(message.details.tasks[0].elapsedMs, end.elapsedMs);
            } else {
                const alreadyRead = message.content;
                fs.writeFileSync(finishFile, 'go');
                await bounded(commandEnded.promise, '命令没有结束');
                const done = await bounded(completionRead.promise, '没有结束通知');
                await session.waitForIdle();
                assert(done.content.includes('FINAL-SDK'));
                assert.equal(message.content, alreadyRead, '不能重写已读进度');
                assert.equal(sendCount, 2);
            }
            console.log('真 SDK 通过：' + (scenario.abort ? '取消但保留队列，默认单条模式下通知仍能更新' : finishBeforeRead ? '排队通知升级为最终结果' : '排队通知读到最新进度，已读内容不改') + '；实际生成边界、公开事件、历史、页面一致，用户文字/图片及其它消息不变。');
        } finally {
            if (originalNow) Date.now = originalNow;
            streamGate.resolve();
            if (job && !frames.some(frame => frame.kind === 'end')) {
                const stop = session.agent.state.tools.find(t => t.name === 'bash_tasks');
                if (stop) await stop.execute('cleanup', { id: job.details.backgroundNo, stop: true }, new AbortController().signal, undefined).catch(() => {});
            }
            if (run) await bounded(run.catch(() => {}), '清理等待超时', 3000).catch(() => {});
            await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
            session.dispose(); display.stopClient();
        }
    }
}


(async () => {
    await checkQueued(); checkDisplay(); await checkSdk();
})().catch(error => { console.error(error); process.exitCode = 1; });
