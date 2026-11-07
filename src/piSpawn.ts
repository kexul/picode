/**
 * 起 pi 进程那一步（中转与后端的退路共用一份）。
 *
 * 为什么单独拆出来：现在有两处要起 pi —— 「中转」（常驻那一层，见 relayMain.ts）与
 * 没有中转时的退路（PiClient 自己 spawn）。两边必须完全一样，否则"有中转"和"没中转"
 * 起出来的 pi 行为不同（比如多了个黑窗口、参数被空格切开），查起来要命。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

/** 起一只 pi 需要的东西（都是后端那边算好交过来的）。 */
export interface PiSpawnSpec {
    /** pi 可执行文件（Windows 上通常是 .cmd） */
    piPath: string;
    /** `--mode rpc`、`-e 扩展`、`--approve` 这些 */
    args: string[];
    /** 它跑在哪个目录（pi 的 switch_session 只换会话文件、不换目录，所以这里定死） */
    cwd: string;
    /** 额外环境变量（几个扩展找自己资源目录的那几个） */
    env?: NodeJS.ProcessEnv;
}

/**
 * Windows 下我们是带 shell 启动 pi 的（pi 是个 .cmd 脚本，不这样起不来），
 * 而 Node 在 shell: true 时**不会**给参数加引号，只是用空格把它们拼起来。
 * 所以带空格的参数（例如家目录带空格时那个扩展文件路径）必须自己加引号，否则会被切成两半。
 *
 * 规则：不含空格/制表符就原样返回；已经自己带着成对引号也原样返回；其余情况用双引号包起来。
 */
export function quoteArgForWindowsShell(arg: string): string {
    if (!arg) { return arg; }
    if (/^["'][^"']*["']$/.test(arg)) { return arg; }
    if (!/[\s"]/.test(arg)) { return arg; }
    return '"' + arg.replace(/"/g, '\\"') + '"';
}

/**
 * 起一只 pi，返回它的三个管道（stdin / stdout / stderr）。
 *
 * 调用方必须一直读 stdout（不读会堵住 pi 的输出，它自己会卡在那儿）；stderr 同理。
 * 关掉 stdout 的读端会让 pi 撞上 EPIPE 崩掉，所以"先不读、等会儿再说"这条路不能走。
 */
export function spawnPi(spec: PiSpawnSpec): ChildProcessWithoutNullStreams {
    const isWindows = process.platform === "win32";
    // shell 启动时参数不会被自动加引号：带空格的（扩展文件路径、cwd 之类）要自己包好
    const command = isWindows ? quoteArgForWindowsShell(spec.piPath) : spec.piPath;
    const args = isWindows ? spec.args.map(quoteArgForWindowsShell) : spec.args;
    return spawn(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        shell: isWindows,
        // 「编译并重启」之后的后端是没有窗口的后台进程（见 serverRestart.ts）：它再经 shell 起 pi 时，
        // Windows 会给这个 shell 新开一个黑窗口（标题就是 pi）。这里一律不让它开窗口。
        windowsHide: isWindows,
    }) as ChildProcessWithoutNullStreams;
}

/** 按 LF 切行（与 piClient 里那份同一个道理：不用 readline，避开 U+2028）。 */
export interface LineSplitter {
    (chunk: string, onLine: (line: string) => void): void;
}

/** 造一个带缓冲的切行器：一行一行交出去（最后不满一行的留在手里）。 */
export function makeLineSplitter(): LineSplitter {
    let buffer = "";
    return (chunk, onLine) => {
        buffer += chunk;
        while (true) {
            const idx = buffer.indexOf("\n");
            if (idx === -1) { break; }
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.endsWith("\r")) { line = line.slice(0, -1); }
            onLine(line);
        }
    };
}
