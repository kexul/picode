/**
 * 后台脚本：塞进 pi 进程里的那个扩展文件的源码。
 *
 * 作用：把 pi 自带的 bash 工具整个换掉（同名注册会盖住内置的，见 pi 的
 * _refreshToolRegistry），换来两件事：
 *   1. 命令可以「脱手」：前台正跑着，让它转到后台接着跑，工具调用当场返回，
 *      模型不用等它 —— 输出继续写日志文件；
 *   2. 一开始就能放到后台跑（bash 多一个 background 参数）。
 * 另外给模型一个 bash_tasks 工具：列后台任务、看输出尾部、停掉。
 *
 * 为什么必须自己跑命令：pi 的内置实现里，进程句柄在它自己手里，工具调用要等进程退出才返回。
 * 我们持着句柄才能中途交出去。
 *
 * 两个方向的消息：
 *   扩展 → 插件：往本进程 stderr 写一行暗号（##PICHAT_BASH## + base64 的 JSON），
 *                报「某条命令转到后台了 / 跑完了」。
 *   插件 → 扩展：插件往 <资源目录>/detach/<这次工具调用的编号> 写一个空文件，
 *                扩展在前台跑命令的时候每半秒看一眼。
 *
 * 跟 pi 对齐的地方（别随手动）：
 *   - shell 怎么挑、命令怎么喂（-c 还是 stdin）直接问 pi 自己（getShellConfig），
 *     settings 里的 shellPath / shellCommandPrefix 也照它的来 —— 别再抄一份它的挑法：
 *     抄的那份漏了 shellPath，另一台机器上 bash 只注册在 settings 里，一跑命令就找不到；
 *     问法也不能只靠 pi.getSettings()：那是个没写进文档的接口，有的版本没有、
 *     有时候还会抛错，于是拿到的设置是空的（报错里「Searched Git Bash in」那半段就是证据）。
 *     取不到就自己去读一份 pi 的设置文件（PI_CODING_AGENT_DIR，默认 ~/.pi/agent）；
 *     而且这份文件**每次都要重读**：pi 换会话（switch_session）时会把扩展再加载一遍，
 *     只有在第一遍读的话，第二遍拿到的设置里就什么都没了（2026-10-30 踩过：
 *     现成会话一载入，这个进程里的 bash 就一直找不到）。
 *     报错里写清楚读的是哪个文件、里面有没有 shellPath、读不出来是什么原因，下次坏在哪儿一眼能看出来。
 *   - 超时和中止时抛的错文案（"timeout:N" / "aborted"），pi 的 bash 工具认这两个；
 *   - 输出截断、格式化、结构化内容那一层没动：仍然走 createBashTool() 给的那份定义。
 *
 * 注意不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 你在终端里手跑的 pi 也会被换掉 bash。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留。
 */
import { BASH_FRAME_PREFIX } from "./bashProtocol";
import { promptText, type PromptOverrides } from "./promptText";

export function bashBridgeSource(over?: PromptOverrides): string {
    return String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 把 bash 换成可以「脱手到后台」的版本，另加一个 bash_tasks 工具。
 */
import { createBashTool, getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const FRAME_PREFIX = ${JSON.stringify(BASH_FRAME_PREFIX)};

/** bash 工具说明里插件加的那一段（人可以在 config.json 的 prompts.toolBash 里改）。 */
const BACKGROUND_NOTE = ${JSON.stringify(promptText(over, "toolBash"))};

/** 往 stderr 写一行暗号（插件在读）。 */
function emit(payload: Record<string, unknown>): void {
    try {
        process.stderr.write(FRAME_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
    } catch {
        // 写不出去就算了：后台命令照样在跑，只是界面上暂时看不见
    }
}

// ---- 目录（插件启动 pi 时用 PICHAT_BASH_DIR 告诉）----

function resourceDir(): string {
    return process.env.PICHAT_BASH_DIR || "";
}
function tasksDir(): string {
    const base = resourceDir();
    return base ? join(base, "tasks") : "";
}
function detachDir(): string {
    const base = resourceDir();
    return base ? join(base, "detach") : "";
}

// ---- shell（整个问 pi：它认 settings 里的 shellPath，我们在它后面接着挑）----

/** pi 的设置（加载本扩展时取一次；改完设置 pi 会重载扩展，这儿也跟着重新取）。 */
let settings: any = {};

interface ShellConfig {
    shell: string;
    args: string[];
    /** 命令从 stdin 喂进去（Windows 上那种老的 WSL bash 只认 -s）。 */
    viaStdin: boolean;
}

/** 设置里写家目录用的 ~ 要自己换开（pi 自己读 settings 时也这么换）。 */
function expandHome(p: string): string {
    if (!p.startsWith("~")) { return p; }
    const home = process.env.USERPROFILE || process.env.HOME || "";
    if (!home) { return p; }
    const rest = p.slice(1).replace(/^[\\/]+/, "");
    return rest ? join(home, rest) : home;
}

/** shellPath 是从哪儿拿到的（pi 给的设置，还是自己读的文件）。 */
let shellPathFrom = "";
/** 自己读的那个设置文件（报错时写出来，好让人知道看的是哪份）。 */
let settingsFile = "";
/** 那个文件读不出来时的原因（报错时照实说：是找不着、打不开、还是里面不是 JSON）。 */
let settingsFileError = "";

/** pi 的配置目录（跟 pi 一样：设了 PI_CODING_AGENT_DIR 就用它，否则 ~/.pi/agent）。 */
function agentDir(): string {
    const fromEnv = process.env.PI_CODING_AGENT_DIR;
    if (fromEnv) { return expandHome(fromEnv); }
    const home = process.env.USERPROFILE || process.env.HOME || "";
    return home ? join(home, ".pi", "agent") : "";
}

/** 自己去读 pi 的设置文件。返回空对象 = 读不到（没这个文件、或里面不是 JSON）。 */
function settingsOnDisk(): any {
    const dir = agentDir();
    settingsFile = dir ? join(dir, "settings.json") : "";
    settingsFileError = "";
    if (!settingsFile) {
        settingsFileError = "找不着（USERPROFILE / HOME 都没有）";
        return {};
    }
    let text: string;
    try {
        text = readFileSync(settingsFile, "utf8");
    } catch (err) {
        settingsFileError = "读不出来（" + String((err && (err as any).code) || (err && (err as Error).message) || err) + "）";
        return {};
    }
    try {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
        settingsFileError = "里不是能认的 JSON（" + String((err && (err as Error).message) || err) + "）";
        return {};
    }
}

/** 挑 shell 要用的两样：pi 给了就用 pi 的，没给再去读它的设置文件。 */
function loadSettings(api: any): any {
    let fromPi: any = {};
    try {
        fromPi = (typeof api.getSettings === "function" ? api.getSettings() : undefined) || {};
    } catch {
        fromPi = {}; // 取不到就按 pi 的默认挑法来
    }
    shellPathFrom = "";
    // 文件每次都读：pi 换会话（switch_session）时会把这个扩展再加载一遍，
    // 只有在第一遍读的话，第二遍拿到的设置里就没有 shellPath 了
    // （2026-10-30 踩过：载入一个已有会话之后，这个进程里的 bash 一直找不到）。
    const fromFile = settingsOnDisk();
    const merged: any = { ...fromPi };
    for (const key of ["shellPath", "shellCommandPrefix"]) {
        if (typeof merged[key] === "string" && merged[key]) { continue; }
        if (typeof fromFile[key] === "string" && fromFile[key]) {
            merged[key] = fromFile[key];
            if (key === "shellPath") { shellPathFrom = settingsFile; }
        }
    }
    if (typeof fromPi.shellPath === "string" && fromPi.shellPath) { shellPathFrom = "pi 给的设置"; }
    return merged;
}

/** 报错时说清楚：这次看到的 shellPath 是什么、从哪儿来的。 */
function shellPathHint(): string {
    const raw = settings.shellPath;
    if (typeof raw === "string" && raw) {
        return "这次用的是 shellPath = " + raw + (shellPathFrom ? "（来自 " + shellPathFrom + "）" : "");
    }
    if (settingsFileError) {
        return "这次没读到 shellPath：pi 给的设置里没有，" + (settingsFile || "pi 的设置文件") + " " + settingsFileError + "。";
    }
    const file = settingsFile ? settingsFile : "（没找到，pi 的配置目录里没有 settings.json）";
    return "这次没读到 shellPath：pi 给的设置里没有，" + file + " 里也没有。";
}

let cachedShell: ShellConfig | undefined;
function shellConfig(): ShellConfig {
    if (cachedShell) { return cachedShell; }
    const shellPath = typeof settings.shellPath === "string" && settings.shellPath ? expandHome(settings.shellPath) : undefined;
    let picked: any;
    try {
        picked = getShellConfig(shellPath);
    } catch (err) {
        throw new Error("找不到 bash：装个 Git Bash、把 bash 放进 PATH，"
            + "或者在 pi 的设置文件（~/.pi/agent/settings.json）里用 shellPath 指到你的 bash。\n\n"
            + shellPathHint() + "\n\n"
            + String((err && (err as Error).message) || err));
    }
    cachedShell = { shell: picked.shell, args: picked.args, viaStdin: picked.commandTransport === "stdin" };
    return cachedShell;
}

/** 设置里的 shellCommandPrefix：每条命令前面先跑的那几行（pi 自己的 bash 也这么加）。 */
function withPrefix(cmd: string): string {
    const prefix = typeof settings.shellCommandPrefix === "string" ? settings.shellCommandPrefix : "";
    return prefix ? prefix + "\n" + cmd : cmd;
}

// ---- 任务表 ----

type TaskStatus = "running" | "done" | "failed" | "stopped";

interface Task {
    no: number;
    /** 这次工具调用的编号（pi 给的；中途切后台时插件靠它对上号）。 */
    id: string;
    cmd: string;
    log: string;
    pid: number;
    startedAt: number;
    status: TaskStatus;
    exitCode: number | null;
    /** 是不是一开始就在后台跑（false = 前台中途转过去的）。 */
    background: boolean;
    /** 报给过插件没有（前台正常跑完的不报：插件从工具事件流里已经知道了）。 */
    announced: boolean;
}

const tasks = new Map<number, Task>();
let seq = 0;

function elapsedMs(task: Task): number {
    return Math.max(0, Date.now() - task.startedAt);
}

function elapsedText(ms: number): string {
    const sec = Math.round(ms / 1000);
    if (sec < 60) { return sec + " 秒"; }
    const min = Math.floor(sec / 60);
    return min + " 分 " + (sec % 60 < 10 ? "0" : "") + (sec % 60) + " 秒";
}

function statusText(task: Task): string {
    if (task.status === "running") { return "还在跑"; }
    if (task.status === "stopped") { return "已停掉"; }
    if (task.status === "failed") { return "失败（退出码 " + task.exitCode + "）"; }
    return "跑完了";
}

/** 杀掉整棵进程树。 */
function killTree(pid: number): void {
    if (!pid) { return; }
    if (process.platform === "win32") {
        try {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        } catch { /* 进程可能已经没了 */ }
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* 同上 */ }
    }
}

/** 读文件最后一段（最多 want 字节）；读不到返回空串。 */
function readTail(file: string, want: number): string {
    try {
        const size = statSync(file).size;
        const from = Math.max(0, size - want);
        const fd = openSync(file, "r");
        try {
            const buf = Buffer.alloc(size - from);
            let got = 0;
            while (got < buf.length) {
                const n = readSync(fd, buf, got, buf.length - got, from + got);
                if (!n) { break; }
                got += n;
            }
            return buf.subarray(0, got).toString("utf8");
        } finally {
            try { closeSync(fd); } catch { /* 算了 */ }
        }
    } catch {
        return "";
    }
}

// ---- 起一条命令（前台、后台共用）----

interface Started {
    task: Task;
    /** 改成只写日志、不再喂给 pi（转到后台后调）。 */
    mute(): void;
    /** 进程退出（或者被我们杀掉）：回调一次，参数是退出码。 */
    onExit(cb: (code: number | null) => void): void;
    /** 杀掉整棵树。 */
    kill(): void;
}

/**
 * 起命令，输出一路写日志文件；feed 是"同一份输出喂给 pi"的那一头（后台任务传空函数）。
 * detached：脱离本进程的进程组 —— 这样 pi 退出、会话关掉，命令还接着跑。
 */
function startTask(
    cmd: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    toolCallId: string,
    background: boolean,
    feed: (chunk: Buffer) => void
): Started {
    const dir = tasksDir();
    if (!dir) { throw new Error("这个会话没拿到后台脚本用的资源目录。"); }
    mkdirSync(dir, { recursive: true });
    mkdirSync(detachDir(), { recursive: true });
    const no = ++seq;
    const log = join(dir, no + ".log");
    let fd = -1;
    try {
        fd = openSync(log, "w");
        writeSync(fd, "$ " + cmd + "\n\n");
    } catch {
        fd = -1;
    }
    const shell = shellConfig();
    const full = withPrefix(cmd);
    const args = shell.viaStdin ? shell.args : [...shell.args, full];
    const child = spawn(shell.shell, args, {
        cwd,
        env: env || process.env,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const task: Task = {
        no,
        id: toolCallId,
        cmd,
        log,
        pid: child.pid || 0,
        startedAt: Date.now(),
        status: "running",
        exitCode: null,
        background,
        announced: false,
    };
    tasks.set(no, task);
    if (shell.viaStdin && child.stdin) {
        child.stdin.on("error", () => { /* 命令不等 stdin，写不进去就算了 */ });
        child.stdin.end(full);
    }
    let muted = false;
    const exitCbs: Array<(code: number | null) => void> = [];
    const writeLog = (chunk: string | Buffer) => {
        if (fd < 0) { return; }
        try { writeSync(fd, chunk); } catch { /* 写不进去不影响命令 */ }
    };
    /**
     * stdout / stderr 的原始字节。日志照原样写（写 Buffer，别先转字符串：多字节字
     * 可能被切在两段之间）；喂给 pi 的也必须是字节 —— 它的 accumulate 按字节数截
     * 断、自己用 TextDecoder 解码，给字符串会当场抛 ERR_INVALID_ARG_TYPE，把整个
     * pi 进程带死（2026-10-28 踩过：会话里一跑命令，pi 就没了）。
     */
    const onData = (chunk: Buffer) => {
        writeLog(chunk);
        if (muted) { return; }
        try { feed(chunk); } catch { /* 交回 pi 那边出错不该把会话带死 */ }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err: Error) => {
        const text = "\n[起不来：" + String((err && err.message) || err) + "]\n";
        writeLog(text);
        if (!muted) { try { feed(Buffer.from(text, "utf8")); } catch { /* 同上 */ } }
    });
    child.on("exit", (code: number | null) => {
        task.exitCode = code;
        task.status = code === 0 ? "done" : "failed";
        writeLog("\n[退出码 " + code + "，用了 " + elapsedText(elapsedMs(task)) + "]\n");
        if (fd >= 0) {
            try { closeSync(fd); } catch { /* 算了 */ }
            fd = -1;
        }
        for (const cb of exitCbs) { cb(code); }
    });
    child.unref();
    return {
        task,
        mute() { muted = true; },
        onExit(cb) { exitCbs.push(cb); },
        kill() { killTree(task.pid); },
    };
}

/** 指令文件的名字：工具调用编号里可能带斜杠（嵌套调用是 <父>/<序号>），换成下划线。 */
function detachFileName(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

/** 把一条任务报给插件（只在它真的要露面时调）。 */
function announce(task: Task, background: boolean): void {
    task.announced = true;
    task.background = background;
    emit({
        kind: "start",
        no: task.no,
        toolCallId: task.id,
        cmd: task.cmd,
        log: task.log,
        background,
        pid: task.pid,
        startedAt: task.startedAt,
    });
}

function reportEnd(task: Task): void {
    emit({
        kind: "end",
        no: task.no,
        toolCallId: task.id,
        cmd: task.cmd,
        log: task.log,
        background: task.background,
        pid: task.pid,
        exitCode: task.exitCode,
        elapsedMs: elapsedMs(task),
    });
}

// ---- 工具 ----

/** 前台调用时「这次是哪个编号、要不要后台」的排队：execute 与 exec 之间没有别的东西插进来。 */
const pending: Array<{ id: string; background: boolean }> = [];
/** 哪些调用被中途转到了后台（execute 收尾时要改口）。 */
const detached = new Map<string, Task>();
/** 哪些调用是一开始就放到后台的（execute 要把「空输出」换成一句说明）。 */
const launched = new Map<string, Task>();

export default function bashBridge(pi: any): void {
    settings = loadSettings(pi);
    const cwd = process.cwd();
    const base = createBashTool(cwd, {
        operations: {
            exec: (command: string, execCwd: string, options: any) => {
                const slot = pending.shift();
                const id = slot ? slot.id : "";
                const background = slot ? slot.background : false;
                const started = startTask(
                    command,
                    execCwd,
                    options.env,
                    id,
                    background,
                    (chunk: Buffer) => { options.onData(chunk); }
                );
                const task = started.task;
                // 一开始就放到后台：立刻返回，输出只进日志，跑完报一声
                if (background) {
                    started.mute();
                    launched.set(id, task);
                    announce(task, true);
                    started.onExit(() => {
                        task.status = task.exitCode === 0 ? "done" : "failed";
                        reportEnd(task);
                    });
                    // 放到后台也照 timeout 掐（模型给了才掐）
                    const bgTimeout = Number(options.timeout);
                    if (bgTimeout > 0) {
                        const timer = setTimeout(() => { started.kill(); }, bgTimeout * 1000);
                        if (typeof timer.unref === "function") { timer.unref(); }
                    }
                    return Promise.resolve({ exitCode: 0 });
                }
                return new Promise<{ exitCode: number }>((resolve, reject) => {
                    let settled = false;
                    let timer: any = undefined;
                    let poll: any = undefined;
                    const cleanup = () => {
                        if (timer) { clearTimeout(timer); timer = undefined; }
                        if (poll) { clearInterval(poll); poll = undefined; }
                    };
                    started.onExit((code: number | null) => {
                        if (task.announced) { reportEnd(task); }
                        if (settled) { return; }   // 转到后台之后跑完：上面已经报过了
                        settled = true;
                        cleanup();
                        resolve({ exitCode: code === null ? 1 : code });
                    });
                    const timeoutSec = Number(options.timeout);
                    if (timeoutSec > 0) {
                        timer = setTimeout(() => {
                            if (settled) { return; }
                            started.kill();
                            settled = true;
                            cleanup();
                            reject(new Error("timeout:" + timeoutSec));
                        }, timeoutSec * 1000);
                    }
                    if (options.signal) {
                        const abort = () => {
                            if (settled) { return; }
                            started.kill();
                            settled = true;
                            cleanup();
                            reject(new Error("aborted"));
                        };
                        if (options.signal.aborted) { abort(); return; }
                        options.signal.addEventListener("abort", abort, { once: true });
                    }
                    // 插件点了「放后台」：目录里出现这次调用的编号，就把工具调用交回去、进程接着跑
                    const dir = detachDir();
                    if (id && dir) {
                        poll = setInterval(() => {
                            if (settled) { return; }
                            const file = join(dir, detachFileName(id));
                            if (!existsSync(file)) { return; }
                            try { unlinkSync(file); } catch { /* 删不掉也不影响 */ }
                            started.mute();
                            announce(task, false);
                            detached.set(id, task);
                            settled = true;
                            cleanup();
                            resolve({ exitCode: 0 });
                        }, 500);
                        if (typeof poll.unref === "function") { poll.unref(); }
                    }
                });
            },
        },
    });

    pi.registerTool({
        ...base,
        description: base.description + "\n\n" + BACKGROUND_NOTE,
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "要执行的命令。" },
                timeout: { type: "number", description: "超时秒数（可选）；放到后台的任务也照这个时间掐掉。" },
                background: {
                    type: "boolean",
                    description: "放到后台跑：立刻返回，不挡当前这一轮。适合跑测试、起服务、等编译这类慢命令。",
                },
            },
            required: ["command"],
            additionalProperties: false,
        },
        async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
            const background = params && params.background === true;
            pending.push({ id, background });
            let result: any;
            try {
                result = await base.execute(id, params, signal, onUpdate, ctx);
            } finally {
                // 起命令那一步没走到（参数不对、shell 找不到）时，这一格别留在队列里
                const at = pending.findIndex((p) => p.id === id);
                if (at >= 0) { pending.splice(at, 1); }
            }
            const bgTask = launched.get(id);
            if (bgTask) {
                launched.delete(id);
                const lines2: string[] = [];
                lines2.push("已经在后台跑了（编号 " + bgTask.no + "）。");
                lines2.push("命令：" + bgTask.cmd);
                lines2.push("输出写在这儿：" + bgTask.log);
                lines2.push("跑完会自动有人把结果告诉你；中途要看输出用 bash_tasks " + bgTask.no + "，要停用 bash_tasks " + bgTask.no + " stop。");
                return {
                    content: [{ type: "text", text: lines2.join("\n") }],
                    details: { backgroundNo: bgTask.no, log: bgTask.log, pid: bgTask.pid },
                };
            }
            const task = detached.get(id);
            if (!task) { return result; }
            detached.delete(id);
            const lines: string[] = [];
            lines.push("这条命令在跑的时候被转到后台了（编号 " + task.no + "），现在还在后台接着跑。");
            lines.push("命令：" + task.cmd);
            lines.push("输出写在这儿：" + task.log);
            lines.push("跑完会自动有人告诉你；中途要看输出用 bash_tasks " + task.no + "，要停用 bash_tasks " + task.no + " stop。");
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { backgroundNo: task.no, log: task.log, pid: task.pid },
            };
        },
    });

    pi.registerTool({
        name: "bash_tasks",
        label: "后台命令",
        description:
            ${JSON.stringify(promptText(over, "toolBashTasks"))},
        promptSnippet: "列后台命令、看它的输出尾部、把它停掉。",
        parameters: {
            type: "object",
            properties: {
                id: { type: "number", description: "任务编号（不带就列出全部）。" },
                stop: { type: "boolean", description: "把它停掉（连它派出来的进程一起）。" },
            },
            additionalProperties: false,
        },
        async execute(_toolCallId: string, params: any) {
            const no = typeof params?.id === "number" ? params.id : 0;
            if (!no) {
                if (tasks.size === 0) {
                    return {
                        content: [{ type: "text", text: "这个会话还没有放到后台跑过的命令。" }],
                        details: { tasks: [] },
                    };
                }
                const list = Array.from(tasks.values()).sort((a, b) => b.no - a.no);
                const lines = list.map((t) => "#" + t.no + "  " + statusText(t) + "，跑了 " + elapsedText(elapsedMs(t))
                    + "\n    命令：" + t.cmd
                    + "\n    输出：" + t.log);
                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: { tasks: list.map((t) => ({ id: t.no, status: t.status, cmd: t.cmd, log: t.log })) },
                };
            }
            const task = tasks.get(no);
            if (!task) {
                return {
                    content: [{ type: "text", text: "没有编号 " + no + " 这个后台任务。用 bash_tasks 不带参数看看都有哪些。" }],
                    details: { error: "not found" },
                };
            }
            if (params && params.stop === true) {
                if (task.status !== "running") {
                    return {
                        content: [{ type: "text", text: "#" + no + " 已经不在跑了（" + statusText(task) + "）。" }],
                        details: { id: no, status: task.status },
                    };
                }
                killTree(task.pid);
                task.status = "stopped";
                if (task.announced) { reportEnd(task); }
                return {
                    content: [{ type: "text", text: "#" + no + " 停掉了（连它派出来的进程一起）。" }],
                    details: { id: no, status: "stopped" },
                };
            }
            const tail = readTail(task.log, 16 * 1024);
            const lines: string[] = [];
            lines.push("#" + no + "  " + statusText(task) + "，跑了 " + elapsedText(elapsedMs(task)));
            lines.push("命令：" + task.cmd);
            lines.push("输出：" + (tail || "（还没有输出）"));
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { id: no, status: task.status, log: task.log },
            };
        },
    });
}
`;
}
