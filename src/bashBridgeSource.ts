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
 * 「放到后台」返回给模型的那段话里必须写明白「不用等」：后台命令跑完的结果只能在
 * 这一轮的模型调用都跑完、下一次请求模型之前交进去（pi 的 steering 就是这个时机），
 * 模型要是写个 sleep 60 干等，结果就被压在队列里陪着一起等（2026-10-31 踩过：
 * 后台命令 21 秒就跑完了，模型 sleep 60 硬等到第 66 秒才拿到结果）。
 *
 * 话说了两遍它照旧干等（2026-11-09 又碰到：起了后台任务，又发一条 sleep 150; tail 日志），
 * 所以现在有两道关，认出来就不给跑（判据与措辞照 pi-famulus 那套）：
 *   命令里干等（sleep 10 秒以上、或循环体里带 sleep）、“甩手”（命令末尾一个孤零零的 &、
 *   nohup、setsid），以及「刚看过又没新东西」的空查。
 * 挡下来只回一句话，不结束这一轮：它该把这一轮说完，等结果自己交回来。
 *
 * 还有一条路是不让它堵：前台撑过 FOREGROUND_BUDGET_MS（照 pi-famulus 的 20 秒）就自己撒手到后台，
 * 命令照跑、输出照进日志，跑完照常交回来。走的是现成的「中途转后台」那条路（announce 里 background=false）。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留。
 */
import {
    BASH_FRAME_PREFIX, BASH_OUTPUT_MAX_CHARS, BASH_NOTICE_TYPE, BASH_CLEAR_NOTICE_COMMAND,
    mergeBashOutput, createBashNoticeFormatter,
} from "./bashProtocol";
import { promptText, type PromptOverrides } from "./promptText";

export function bashBridgeSource(over?: PromptOverrides): string {
    return String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 把 bash 换成可以「脱手到后台」的版本，另加一个 bash_tasks 工具。
 */
import { createBashTool, getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const FRAME_PREFIX = ${JSON.stringify(BASH_FRAME_PREFIX)};
const OUTPUT_MAX_CHARS = ${BASH_OUTPUT_MAX_CHARS};
const NOTICE_TYPE = ${JSON.stringify(BASH_NOTICE_TYPE)};
const CLEAR_NOTICE_COMMAND = ${JSON.stringify(BASH_CLEAR_NOTICE_COMMAND)};
const mergeOutput = (${mergeBashOutput.toString()});
const formatNotice = (${createBashNoticeFormatter.toString()})(
    ${JSON.stringify(promptText(over, "bashOutputDelivery"))},
    ${JSON.stringify(promptText(over, "bashDelivery"))}
);

/** bash 工具说明里插件加的那一段（人可以在 config.json 的 prompts.toolBash 里改）。 */
const BACKGROUND_NOTE = ${JSON.stringify(promptText(over, "toolBash"))};

/**
 * bash 工具说明末尾固定接的一句（不让人改、也不进 prompts 那套）。
 *
 * 为什么不写进上面的 BACKGROUND_NOTE：设置文件里的 prompts 一节只写一次，里面存着
 * 第一次启动时的那份原文，改内置原文对已经装过的机器不生效（那些机器上一直是老话）。
 * 而「别干等」这句一旦缺了，模型就会拿 sleep 去凑时间，结果只能在一轮跑完之后才交进来，
 * 干等多久就白等多久（见文件开头）。这一句必须永远能送到模型眼前，所以写在代码里。
 */
const NO_WAIT_NOTE = "放到后台以后不用等结果：你可以接着去干别的，或者直接把这一轮说完结束；"
    + "它跑完的结果会当成一条新消息交回本会话（开头是「后台命令 #编号 跑完了」）。"
    + "别用 sleep 之类的命令干等，也别反复用 bash_tasks 查 —— 你干等的时候结果只能排在后面，等多久就白等多久。"
    + "真在命令里干等的（sleep 10 秒以上、或者循环里带 sleep）、以及把进程丢到背影里跑的（末尾孤零零的 &、nohup、setsid）会被挡回来，这一条不会跑；"
    + "刚看过一次、它又没出新东西的时候再查，也会被挡回来。"
    + "前台命令撑过 20 秒还没跑完会自己转到后台（不用你管，也不用再发一遍），跑完照常交回来。"
    + "bash 的 notifyOutput 默认是 false：后台只在跑完时通知，中途要看输出用 bash_tasks；"
    + "设成 true 后，命令转到后台才会自动通知新输出，前台输出仍只走正常工具结果；"
    + "模型忙时合并，空闲时同一会话的输出通知至少隔两秒，没有新输出就不通知，结束时剩余输出和结果一起交回。";

/**
 * 命令里干等的那一关：认出来就不跑。
 *
 * 光靠说明书没用（这一条已在上面 NO_WAIT_NOTE 与工具说明里写过两遍，模型照旧拿 sleep 凑时间），
 * 只能不给它跑。判据照 pi-famulus 的 wait-guard：sleep 秒数到 10，或者循环体里带 sleep；
 * 引号里、heredoc 正文里、注释里的不算（先剥掉再判），免得 python - <<EOF … EOF 或者
 * ansible -a '…' 这种被误伤。
 */
const WAIT_SLEEP_MIN_S = 10;
const WAIT_SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)/g;
const WAIT_SLEEP_LOOP = /\b(while|until|for)\b[\s\S]*?\bdo\b(?:(?!\bdone\b)[\s\S])*\bsleep\b/;

/** 把本地 shell 不当命令执行的部分去掉：heredoc 正文、引号里的、注释。 */
function shellWords(command: string): string {
    let s = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<heredoc");
    s = s.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
    s = s.replace(/(^|\s)#[^\n]*/g, "$1");
    return s;
}

/** 这条命令是在干等吗？是的话回「等的是什么」，不是就空串。 */
function waitReason(command: string): string {
    const words = shellWords(command);
    if (WAIT_SLEEP_LOOP.test(words)) { return "循环里带 sleep"; }
    for (const m of words.matchAll(WAIT_SLEEP)) {
        if (Number(m[1]) >= WAIT_SLEEP_MIN_S) { return "sleep " + m[1] + " 秒"; }
    }
    return "";
}

/**
 * 「拜手」那一关：把进程丢到背影里跑了、这一截命令马上就完了，它的输出和退出码谁也拿不到
 * （判据照 pi-famulus）：命令末尾一个孤零零的 &，或者 nohup / setsid / disown。
 * 2>&1 、&& 、&> 这些重定向与连接符不算（前面后面紧贴着 & 或 > 的排除掉）。
 */
const DETACH_SHAPE = /(^|[^&>|])&(?![&>])|\b(nohup|setsid|disown)\b/m;

function detachReason(command: string): string {
    const words = shellWords(command);
    const m = DETACH_SHAPE.exec(words);
    if (!m) { return ""; }
    return m[2] ? m[2] : "末尾那个 &";
}

/** 拦下来的那三句话（原文在 promptText.ts 的 guardWait / guardDetach / guardPoll，人能改）。 */
const GUARD_WAIT_TEXT = ${JSON.stringify(promptText(over, "guardWait"))};
const GUARD_DETACH_TEXT = ${JSON.stringify(promptText(over, "guardDetach"))};
const GUARD_POLL_TEXT = ${JSON.stringify(promptText(over, "guardPoll"))};

/** 把模板里的 {{名字}} 换成值（跟 promptText.ts 的 renderPrompt 一个意思，这边没法 import 那边）。 */
function fillText(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (whole, name: string) => {
        const value = vars[name];
        return value === undefined ? whole : value;
    });
}

function logSize(log: string): number {
    try { return statSync(log).size; } catch { return 0; }
}

/**
 * 前台命令跑多久就自己撒手到后台（毫秒），照 pi-famulus 的 20 秒。
 * 想改就在启动 pi 的环境里设 PICHAT_BASH_FOREGROUND_MS —— 插件现在没往这个口子传东西，
 * 所以正常人看到的就是 20 秒。设成 0 或负数就不自动撒手（回到以前那样一直等到跑完）。
 */
function foregroundBudgetMs(): number {
    const raw = process.env.PICHAT_BASH_FOREGROUND_MS;
    if (raw === undefined || raw === "") { return 20000; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { return 0; }
    return n;
}

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

export default function bashBridge(pi: any): void {
    settings = loadSettings(pi);

// ---- 任务表（只属于这次扩展实例）----

type TaskStatus = "running" | "done" | "failed" | "stopped";

interface TaskOutput {
    text: string;
    firstAt: number;
    lastAt: number;
    omittedChars?: number;
}

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
    /** 结尾报给过插件没有：一条任务只报一次结尾（停止与退出可能挨在一起，别报两遍）。 */
    reported: boolean;
    notifyOutput: boolean;
    /** 停止或进程退出后不再单发输出，剩余输出随结束通知交回。 */
    ending: boolean;
    output?: TaskOutput;
    /** 真正结束的时刻，交回通知的等待时间不算命令耗时。 */
    endedAt?: number;
    /** 没开启进度通知时，结束就保存日志尾部，不能排队之后再读其它命令覆盖的日志。 */
    endTail?: string;
    /** 模型已收到这条任务的结束结果。 */
    endNotified: boolean;
}

const tasks = new Map<number, Task>();
let seq = 0;

/** 只攒转到后台后的新输出，模型消费通知前一直保留；原文仍在日志里。 */
function collectOutput(task: Task, text: string): void {
    if (!text || !task.notifyOutput || !task.announced || task.reported || tasks.get(task.no) !== task) { return; }
    const now = Date.now();
    task.output = mergeOutput(task.output, { text, firstAt: now, lastAt: now }, OUTPUT_MAX_CHARS);
    scheduleNotice();
}

function outputNotice(task: Task): string {
    return task.notifyOutput
        ? "notifyOutput 已开启：转到后台后的新输出会自动交回本会话，模型忙时先合并，不用反复查。"
        : "notifyOutput 默认关闭：中途输出不会自动通知，要看输出用 bash_tasks；下次设 notifyOutput: true 可开启。";
}

function elapsedMs(task: Task): number {
    return Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt);
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
function killTree(pid: number): boolean {
    if (!pid) { return false; }
    if (process.platform === "win32") {
        try {
            return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).status === 0;
        } catch { return false; }
    }
    try {
        process.kill(-pid, "SIGKILL");
        return true;
    } catch {
        try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
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
    /** 不再喂给 pi，日志照写；开启通知时另攒后台新输出。 */
    mute(): void;
    /** 主进程退出后等尾部输出（最多一秒）：回调一次，参数是退出码。 */
    onExit(cb: (code: number | null) => void): void;
    /** 杀掉整棵树。 */
    kill(): void;
}

/**
 * 起命令，输出一路写日志文件；feed 把同一份字节交给当前工具调用，转后台后不再调用它。
 * detached：脱离本进程的进程组 —— 这样 pi 退出、会话关掉，命令还接着跑。
 */
function startTask(
    cmd: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    toolCallId: string,
    background: boolean,
    notifyOutput: boolean,
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
        reported: false,
        endNotified: false,
        notifyOutput,
        ending: false,
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
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer, decoder: StringDecoder) => {
        writeLog(chunk);
        // 两路分别解码，前台也喂给 decoder，但不攒前台已交给 pi 的输出。
        const text = task.notifyOutput ? decoder.write(chunk) : "";
        if (muted) { collectOutput(task, text); return; }
        try { feed(chunk); } catch { /* 交回 pi 那边出错不该把会话带死 */ }
    };
    child.stdout?.on("data", (chunk: Buffer) => onData(chunk, stdoutDecoder));
    child.stderr?.on("data", (chunk: Buffer) => onData(chunk, stderrDecoder));
    child.on("error", (err: Error) => {
        const text = "\n[起不来：" + String((err && err.message) || err) + "]\n";
        writeLog(text);
        if (muted) { collectOutput(task, text); }
        else { try { feed(Buffer.from(text, "utf8")); } catch { /* 同上 */ } }
    });
    let finished = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, pipesOpen = false) => {
        if (finished) { return; }
        finished = true;
        if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
        task.ending = true;
        task.endedAt ??= Date.now();
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (muted) {
            collectOutput(task, stdoutTail);
            collectOutput(task, stderrTail);
        }
        if (pipesOpen) {
            const notice = "\n[主进程已退出，输出管道尚未关闭；这里只包含目前读到的输出，后代进程可能仍在运行]\n";
            writeLog(notice);
            if (muted) { collectOutput(task, notice); }
            else { try { feed(Buffer.from(notice, "utf8")); } catch { /* 同上 */ } }
        }
        task.exitCode = code;
        if (task.status !== "stopped") { task.status = code === 0 ? "done" : "failed"; }
        writeLog("\n[退出码 " + code + "，用了 " + elapsedText(elapsedMs(task)) + "]\n");
        if (fd >= 0) {
            try { closeSync(fd); } catch { /* 算了 */ }
            fd = -1;
        }
        for (const cb of exitCbs) { cb(code); }
    };
    child.on("exit", (code: number | null) => {
        task.ending = true;
        task.endedAt ??= Date.now();
        // 正常先等 close 读完尾部；后代持着管道不关时，不能永远卡着工具和结束通知。
        closeTimer = setTimeout(() => finish(code, true), 1000);
        if (typeof closeTimer.unref === "function") { closeTimer.unref(); }
    });
    child.on("close", (code: number | null) => finish(code));
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
    if (tasks.get(task.no) !== task) { return; }
    task.announced = true;
    task.background = background;
    emit({
        kind: "start",
        no: task.no,
        toolCallId: task.id,
        cmd: task.cmd,
        log: task.log,
        background: task.background,
        pid: task.pid,
        startedAt: task.startedAt,
        notifyOutput: task.notifyOutput,
    });
}

function reportEnd(task: Task): void {
    if (task.reported || tasks.get(task.no) !== task) { return; }
    task.reported = true;
    if (!task.notifyOutput) { task.endTail = readTail(task.log, OUTPUT_MAX_CHARS); }
    emit({
        kind: "end",
        no: task.no,
        toolCallId: task.id,
        cmd: task.cmd,
        log: task.log,
        background: task.background,
        pid: task.pid,
        status: task.status,
        exitCode: task.exitCode,
        elapsedMs: elapsedMs(task),
        notifyOutput: task.notifyOutput,
    });
    scheduleNotice();
}

// ---- 工具 ----

/** 前台调用时「这次是哪个编号、要不要后台」的排队：execute 与 exec 之间没有别的东西插进来。 */
const pending: Array<{ id: string; background: boolean; notifyOutput: boolean }> = [];
/** 哪些调用被中途转到了后台（execute 收尾时要改口）：记着那条任务、以及是用户点的还是自己撒的。 */
const detached = new Map<string, { task: Task; by: "user" | "budget" }>();
/** 哪些调用是一开始就放到后台的（execute 要把「空输出」换成一句说明）。 */
const launched = new Map<string, Task>();

/** 上次看任务时的日志大小，只用来拦下没有新输出的重复查询。 */
const lookedAt = new Map<number, number>();
const owner = randomUUID();
let noticeSeq = 0;
let currentCtx: any;
let sessionActive = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimerAt = 0;
let lastNoticeAt = 0;
let pendingNotice: { noticeId: number; tasks: Set<number>; startedOwnRun: boolean } | undefined;

function clearNoticeTimer(): void {
    if (noticeTimer !== undefined) { clearTimeout(noticeTimer); }
    noticeTimer = undefined;
    noticeTimerAt = 0;
}

function resetNotices(): void {
    clearNoticeTimer();
    pendingNotice = undefined;
    lastNoticeAt = 0;
    currentCtx = undefined;
    sessionActive = false;
    tasks.clear();
    lookedAt.clear();
    pending.length = 0;
    detached.clear();
    launched.clear();
}

/** reported 才算真正结束；kill 已成功但 close 还没收场时，继续等尾部。 */
function noticeTasks(): Task[] {
    return Array.from(tasks.values()).filter((task) => task.announced && !task.endNotified
        && (task.reported || (task.notifyOutput && task.output && !task.ending)))
        .sort((a, b) => Number(b.reported) - Number(a.reported) || a.no - b.no);
}

function addPendingTasks(): void {
    if (!pendingNotice) { return; }
    for (const task of noticeTasks()) {
        if (pendingNotice.tasks.size >= 4) { break; }
        pendingNotice.tasks.add(task.no);
    }
}

/** 同一实例只有一个计时器；完成结果可以把原本等待输出的计时器提前。 */
function armNoticeTimer(delay: number): void {
    const at = Date.now() + delay;
    if (noticeTimer !== undefined && noticeTimerAt <= at) { return; }
    clearNoticeTimer();
    noticeTimerAt = at;
    noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        noticeTimerAt = 0;
        flushNotice();
    }, delay);
    noticeTimer.unref?.();
}

function scheduleNotice(): void {
    if (!sessionActive || !currentCtx) { return; }
    if (pendingNotice) {
        addPendingTasks();
        // custom 通知不在用户文字队列计数里，不能据此猜它丢失；保留到真正消费。
        return;
    }
    const ready = noticeTasks();
    if (ready.some((task) => task.reported)) { armNoticeTimer(0); return; }
    if (ready.length === 0 || !currentCtx.isIdle()) { return; }
    armNoticeTimer(Math.max(300, 2000 - (Date.now() - lastNoticeAt)));
}

function flushNotice(): void {
    if (!sessionActive || !currentCtx) { return; }
    if (pendingNotice) { addPendingTasks(); return; }
    const now = Date.now();
    const progressAllowed = currentCtx.isIdle() && now - lastNoticeAt >= 2000;
    const selected = noticeTasks().filter((task) => task.reported || progressAllowed).slice(0, 4);
    if (selected.length === 0) { scheduleNotice(); return; }
    const notice = { noticeId: ++noticeSeq, tasks: new Set(selected.map((task) => task.no)), startedOwnRun: false };
    pendingNotice = notice;
    lastNoticeAt = now;
    const failed = () => {
        if (pendingNotice !== notice || !sessionActive) { return; }
        pendingNotice = undefined;
        armNoticeTimer(2000);
    };
    try {
        const sent = pi.sendMessage({
            customType: NOTICE_TYPE,
            content: "后台命令通知，交回时会填入最新输出。",
            display: false,
            details: { owner, noticeId: notice.noticeId, ready: false },
        }, { triggerTurn: true, deliverAs: "steer" });
        // 也兼容返回 Promise 的调用方；发送失败不丢输出，下次再交。
        Promise.resolve(sent).catch(failed);
    } catch {
        failed();
    }
}

pi.on("session_start", (_event: any, ctx: any) => {
    resetNotices();
    currentCtx = ctx;
    sessionActive = true;
    scheduleNotice();
});
pi.on("session_shutdown", () => { resetNotices(); });
pi.registerCommand(CLEAR_NOTICE_COMMAND, {
    description: "后端内部：界面已按用户要求清空队列",
    handler: (_args: string, ctx: any) => {
        currentCtx = ctx;
        if (pendingNotice) {
            for (const no of pendingNotice.tasks) {
                const task = tasks.get(no);
                if (!task) { continue; }
                task.output = undefined;
                task.endTail = undefined;
                if (task.reported) { task.endNotified = true; }
            }
        }
        pendingNotice = undefined;
        clearNoticeTimer();
        // 只取消已清掉的那份通知。未来的新输出仍可通知，不发模型消息，不清 pi 队列。
    },
});
pi.on("before_agent_start", (event: any) => {
    const details = event.message?.details;
    if (pendingNotice && event.messageType === "custom" && event.message?.customType === NOTICE_TYPE
        && details?.owner === owner && details.noticeId === pendingNotice.noticeId) {
        pendingNotice.startedOwnRun = true;
    }
});
pi.on("agent_start", (_event: any, ctx: any) => {
    if (!sessionActive) { return; }
    currentCtx = ctx;
    scheduleNotice();
});
pi.on("agent_settled", (event: any, ctx: any) => {
    if (!sessionActive) { return; }
    currentCtx = ctx;
    // 只释放已启动自己的回复、却没能交回起始通知的失败；忙时排队的通知可能仍在队列里。
    if (pendingNotice?.startedOwnRun) { pendingNotice = undefined; return; }
    scheduleNotice();
});
pi.on("message_end", (event: any) => {
    const message = event?.message;
    // 用户新说了一句话，只重置重复查询的判据，不改这条消息。
    if (message?.role === "user") { lookedAt.clear(); return; }
    const details = message?.details;
    if (!sessionActive || message?.role !== "custom" || message.customType !== NOTICE_TYPE
        || details?.owner !== owner || details.noticeId !== pendingNotice?.noticeId
        || details.ready !== false || !pendingNotice) { return; }
    addPendingTasks();
    const selected = Array.from(pendingNotice.tasks).map((no) => tasks.get(no))
        .filter((task): task is Task => !!task && !task.endNotified);
    const completed = selected.filter((task) => task.reported);
    const running = selected.filter((task) => !task.reported && task.output);
    const content = [
        ...completed.map((task) => formatNotice.completion({
            ...task,
            toolCallId: task.id,
            elapsedMs: elapsedMs(task),
            tail: task.endTail ?? "",
        })),
        ...(running.length ? [formatNotice.progress(running.map((task) => ({ ...task, toolCallId: task.id })))] : []),
    ].join("\n\n");
    const summary = selected.map((task) => ({
        no: task.no, toolCallId: task.id,
        status: task.reported ? task.status : "running",
        elapsedMs: elapsedMs(task), notifyOutput: task.notifyOutput,
    }));
    // 到这一步才是真正消费通知：已填好的消息不会再修改，也不会重放已交回的结束结果。
    for (const task of selected) {
        task.output = undefined;
        task.endTail = undefined;
        if (task.reported) { task.endNotified = true; }
    }
    pendingNotice = undefined;
    lastNoticeAt = Date.now();
    clearNoticeTimer();
    scheduleNotice();
    return { message: {
        ...message, content, display: true,
        details: { ...details, ready: true, tasks: summary },
    } };
});
    const cwd = process.cwd();
    const base = createBashTool(cwd, {
        operations: {
            exec: (command: string, execCwd: string, options: any) => {
                const slot = pending.shift();
                const id = slot ? slot.id : "";
                const background = slot ? slot.background : false;
                const notifyOutput = slot ? slot.notifyOutput : false;
                const started = startTask(
                    command,
                    execCwd,
                    options.env,
                    id,
                    background,
                    notifyOutput,
                    (chunk: Buffer) => { options.onData(chunk); }
                );
                const task = started.task;
                // 一开始就放到后台：立刻返回，输出进日志，开启通知时另报新输出
                if (background) {
                    started.mute();
                    launched.set(id, task);
                    announce(task, true);
                    started.onExit(() => { reportEnd(task); });
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
                    let budget: any = undefined;
                    const cleanup = () => {
                        if (timer) { clearTimeout(timer); timer = undefined; }
                        if (poll) { clearInterval(poll); poll = undefined; }
                        if (budget) { clearTimeout(budget); budget = undefined; }
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
                            detached.set(id, { task, by: "user" });
                            settled = true;
                            cleanup();
                            resolve({ exitCode: 0 });
                        }, 500);
                        if (typeof poll.unref === "function") { poll.unref(); }
                    }
                    // 前台撑过预算就自己撒手：命令照跑、输出照进日志，这一轮接着往下走，
                    // 跑完照常交回来。给了更短的 timeout 的话，那是硬上限，先到先算。
                    // 预算设成 0（PICHAT_BASH_FOREGROUND_MS=0）就不装这个计时器。
                    const budgetMs = foregroundBudgetMs();
                    if (budgetMs > 0) {
                        budget = setTimeout(() => {
                            if (settled) { return; }
                            started.mute();
                            announce(task, false);
                            detached.set(id, { task, by: "budget" });
                            settled = true;
                            cleanup();
                            resolve({ exitCode: 0 });
                        }, budgetMs);
                        if (typeof budget.unref === "function") { budget.unref(); }
                    }
                });
            },
        },
    });

    pi.registerTool({
        ...base,
        description: base.description + "\n\n" + BACKGROUND_NOTE + "\n" + NO_WAIT_NOTE,
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "要执行的命令。" },
                timeout: { type: "number", description: "超时秒数（可选）；放到后台的任务也照这个时间掐掉。" },
                background: {
                    type: "boolean",
                    description: "放到后台跑：立刻返回，不挡当前这一轮。",
                },
                notifyOutput: {
                    type: "boolean",
                    default: false,
                    description: "自动通知后台新输出（可选，默认关闭）。只在显式放后台、手动转后台或前台超过 20 秒后生效；模型忙时合并，空闲时输出通知至少隔两秒。前台输出不重复通知。",
                },
            },
            required: ["command"],
            additionalProperties: false,
        },
        async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
            if (sessionActive) { currentCtx = ctx; scheduleNotice(); }
            const background = params && params.background === true;
            const notifyOutput = params && params.notifyOutput === true;
            const command = params && typeof params.command === "string" ? params.command : "";
            const waited = waitReason(command);
            if (waited) {
                // 不跑：这条命令的意义就是等，而等是白等（见文件开头那段）。也不进 pending：
                // 没起进程，就没什么可"转到后台"的
                return {
                    content: [{ type: "text", text: fillText(GUARD_WAIT_TEXT, { 原因: waited }) }],
                    details: { blocked: "wait", reason: waited },
                };
            }
            const detachedAway = detachReason(command);
            if (detachedAway) {
                // 不跑：丢到背影里跑的那些，输出与退出码都回不来（见上面 DETACH_SHAPE）
                return {
                    content: [{ type: "text", text: fillText(GUARD_DETACH_TEXT, { 原因: detachedAway }) }],
                    details: { blocked: "detach", reason: detachedAway },
                };
            }
            pending.push({ id, background, notifyOutput });
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
                lines2.push(outputNotice(bgTask));
                lines2.push("不用等它：你可以接着去干别的，或者直接把这一轮说完结束。");
                lines2.push("它跑完的结果会当成一条新消息交进来（开头是「后台命令 #" + bgTask.no + " 跑完了」）。");
                lines2.push("别用 sleep 之类的命令干等，也别反复用 bash_tasks 查 —— 你干等的时候结果只能排在后面，等多久就白等多久。");
                lines2.push("中途要看输出用 bash_tasks " + bgTask.no + "，要停用 bash_tasks " + bgTask.no + " stop。");
                return {
                    content: [{ type: "text", text: lines2.join("\n") }],
                    details: { backgroundNo: bgTask.no, log: bgTask.log, pid: bgTask.pid },
                };
            }
            const gone = detached.get(id);
            if (!gone) { return result; }
            detached.delete(id);
            const task = gone.task;
            const lines: string[] = [];
            lines.push(gone.by === "user"
                ? "这条命令在跑的时候被转到后台了（编号 " + task.no + "），现在还在后台接着跑。"
                : "这条命令撑了 " + Math.max(1, Math.round(foregroundBudgetMs() / 1000)) + " 秒还没跑完，已经转到后台接着跑了（编号 " + task.no + "）。");
            lines.push("命令：" + task.cmd);
            lines.push("输出写在这儿：" + task.log);
            lines.push(outputNotice(task));
            lines.push("接下来不用等它：你可以接着去干别的，或者直接把这一轮说完结束。");
            lines.push("它跑完的结果会当成一条新消息交进来（开头是「后台命令 #" + task.no + " 跑完了」）。");
            lines.push("别用 sleep 之类的命令干等，也别反复用 bash_tasks 查 —— 你干等的时候结果只能排在后面，等多久就白等多久。");
            lines.push("中途要看输出用 bash_tasks " + task.no + "，要停用 bash_tasks " + task.no + " stop。");
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
        async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
            if (sessionActive) { currentCtx = ctx; scheduleNotice(); }
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
                if (!killTree(task.pid)) {
                    return {
                        content: [{ type: "text", text: "#" + no + " 没能确认停止，命令可能已经退出或停止请求失败；仍按实际输出和退出结果通知，可以稍后再试。" }],
                        details: { id: no, status: task.status, error: "stop failed" },
                    };
                }
                task.status = "stopped";
                task.ending = true;
                // close 读完日志尾部再 reportEnd，未发送输出只随结尾交回一次。
                return {
                    content: [{ type: "text", text: "#" + no + " 停掉了（连它派出来的进程一起）。" }],
                    details: { id: no, status: "stopped" },
                };
            }
            // 空查那一关：还在跑、且从上次看它到现在日志一个字节都没长，就不给看（见文件开头那段）。
            // 第一次看、出过新东西、以及跑完的，都照常给。
            if (task.status === "running") {
                const nowSize = logSize(task.log);
                const before = lookedAt.get(no);
                if (before !== undefined && nowSize === before) {
                    return {
                        content: [{ type: "text", text: fillText(GUARD_POLL_TEXT, { 编号: String(no) }) }],
                        details: { blocked: "poll", id: no, status: task.status },
                    };
                }
                lookedAt.set(no, nowSize);
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
