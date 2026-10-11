/**
 * 独立后端自己写的那几份文件（不引用 vscode，可以单测）。
 *
 * 两个用途：
 *   - 显示选项的存档（VSCode 侧边栏存 globalState，独立后端没人给这份存储，只好自己存一份文件）；
 *   - 记下"现在跑着的那个后端是谁、在哪里"，下次启动时靠它判断是不是已经有实例在跑（单实例）。
 *
 * 文件位置由 serverPaths 给；测试把环境变量 PICHAT_HOME 指到临时目录，就不会动到用户的真配置。
 */
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { serverAddressFile, serverStateFile } from "./serverPaths";

/** 探活时最多读多少字节的回应。探的是一小段 JSON，读到这么多还没完，端口上多半不是我们。 */
const MAX_HEALTH_BYTES = 64 * 1024;

/** 探活的默认超时（毫秒）。单实例判断在启动路上，等太久会让人觉得"点了没反应"。 */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** 显示选项那份状态文件（对应 VSCode 的 globalState：界面颜色、字号、快捷键这些）。 */
export class ServerStateStore {
    private readonly file: string;

    constructor(file: string = serverStateFile()) {
        this.file = file;
    }

    /** 读一个键；文件不在 / 读坏 / 存值的类型跟默认值对不上，都回 fallback。 */
    get<T>(key: string, fallback: T): T {
        const value = this.readAll()[key];
        if (value === undefined || value === null) { return fallback; }
        // 类型对不上就回默认值：界面按类型来用它（比如真值判断），
        // 存进去的要是别的类型，勉强用出去只会得到莫名其妙的行为。
        if (typeof value !== typeof fallback) { return fallback; }
        // 数组和对象都是 "object"，但界面用法完全不同；容器类型也要对得上。
        if (Array.isArray(value) !== Array.isArray(fallback)) { return fallback; }
        return value as T;
    }

    /** 写一个键（立即写盘，同步）。写不进去也不能把调用方带崩：选项丢一份不致命。 */
    update(key: string, value: unknown): void {
        const data = this.readAll();
        data[key] = value;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n", "utf8");
        } catch (err: any) {
            console.error(`保存显示选项失败（${this.file}）：${err?.message ?? String(err)}`);
        }
    }

    /** 全部键（调试用）。 */
    all(): Record<string, unknown> {
        return this.readAll();
    }

    /** 每次现读现解析：文件可能被别的进程（另一个窗口）改过，不能缓存一份旧的。 */
    private readAll(): Record<string, unknown> {
        let text: string;
        try {
            text = fs.readFileSync(this.file, "utf8");
        } catch {
            return {};   // 文件还不存在是常态（第一次用），别打日志刷屏
        }
        try {
            const parsed = JSON.parse(text) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { return {}; }
            return parsed as Record<string, unknown>;
        } catch {
            // 坏 JSON（写了一半、被人手改了）：当没有这份存档，界面照常能开
            return {};
        }
    }
}

/** 地址文件里记的内容：现在跑着的那个后端是谁、在哪里。 */
export interface ServerAddress {
    app: "pichat";
    version: string;
    pid: number;
    port: number;
    host: string;
    /** 给人看的地址，例如 http://192.168.1.5:51883/ 。 */
    url: string;
    startedAt: number;
}

/** 读地址文件；文件不在 / 坏 JSON / 字段不全，都当没有（返回 undefined）。 */
export function readServerAddress(file: string = serverAddressFile()): ServerAddress | undefined {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return undefined;   // 文件不在是常态（还没有实例跑过）
    }
    try {
        const parsed = JSON.parse(text) as unknown;
        return isServerAddress(parsed) ? parsed : undefined;
    } catch {
        return undefined;   // 坏 JSON：当没有，别把启动判断带崩
    }
}

/** 写地址文件（2 空格缩进 + 末尾换行，方便人看和比对）。写失败让调用方知道：单实例判断靠它。 */
export function writeServerAddress(addr: ServerAddress, file: string = serverAddressFile()): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(addr, null, 2) + "\n", "utf8");
}

/** 清掉地址文件（后端收摊时、或发现是过期文件时）。文件本来就不在也不用报错。 */
export function clearServerAddress(file: string = serverAddressFile()): void {
    try {
        fs.unlinkSync(file);
    } catch {
        // 已经不在了就是好事；这里没有别的失败要处理
    }
}

/**
 * 去问一个地址是不是活着的 pichat 后端（GET <地址>/health）；不是、或连不上，回 undefined。
 *
 * 故意不用 fetch：这里要能手写超时，而且探活只发一个很简单的 GET，
 * Node 自带的 http/https 就够，不必为它引入运行时依赖。
 */
export function probeServer(url: string, timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<ServerAddress | undefined> {
    return new Promise((resolve) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            resolve(undefined);
            return;
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
            resolve(undefined);
            return;
        }
        // 地址可能已经带结尾斜杠；统一成 "/health"，免得拼出 "//health" 这种请求路径。
        const basePath = target.pathname.endsWith("/") ? target.pathname : `${target.pathname}/`;
        const healthUrl = new URL(`${basePath}health`, target.origin);
        const transport = healthUrl.protocol === "https:" ? https : http;

        // 超时、报错、读完，这三条路都想结束这次探活；先到的那条说了算。
        let settled = false;
        const finish = (value: ServerAddress | undefined) => {
            if (settled) { return; }
            settled = true;
            resolve(value);
        };

        const req = transport.get(healthUrl, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();   // 把内容读掉，连接才能释放
                finish(undefined);
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_HEALTH_BYTES) {
                    res.destroy();
                    finish(undefined);
                    return;
                }
                chunks.push(chunk);
            });
            res.on("error", () => finish(undefined));
            res.on("end", () => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                } catch {
                    finish(undefined);   // 回的都不是 JSON，当然不是我们
                    return;
                }
                // 同一个端口上可能跑着别的服务（用户把端口填成了别的程序）：
                // 必须核对门牌，宁可当探不到，也不能把别人认成自己的后端。
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
                    || (parsed as Record<string, unknown>).app !== "pichat") {
                    finish(undefined);
                    return;
                }
                // 以对方自报的为准：地址文件可能是上一个进程留下的，早就过期了。
                finish(addressFromHealth(parsed as Record<string, unknown>, target));
            });
        });
        req.on("timeout", () => {
            req.destroy();   // 光靠 timeout 事件不会真的断开，得自己销毁
            finish(undefined);
        });
        req.on("error", () => finish(undefined));
    });
}

/**
 * 单实例判断：地址文件里那个后端还活着就返回它，否则返回 undefined（顺带把过期文件清掉）。
 *
 * 探活结果以对方自报的为准：地址文件可能是上次崩溃前留下的，
 * 里面的端口、进程号早就不是现在这个后端了。
 */
export async function findRunningServer(
    file: string = serverAddressFile(),
    timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ServerAddress | undefined> {
    const saved = readServerAddress(file);
    if (!saved) { return undefined; }
    const alive = await probeServer(saved.url, timeoutMs);
    if (alive) { return alive; }
    // 探不到（进程没了、换了端口、或者那个端口上根本不是我们）：
    // 这份文件是过期的。不清理的话，下一个后端会以为"已经有实例在跑"而拒绝启动，
    // 把用户卡在"说什么都起不来"里。顺手清掉，让新实例顺利接管。
    clearServerAddress(file);
    return undefined;
}

/** 地址文件是不是一份完整的 {@link ServerAddress}（字段缺了就当没有，后面会按"没有"处理）。 */
function isServerAddress(value: unknown): value is ServerAddress {
    if (!value || typeof value !== "object" || Array.isArray(value)) { return false; }
    const v = value as Record<string, unknown>;
    return v.app === "pichat"
        && typeof v.version === "string"
        && typeof v.pid === "number"
        && typeof v.port === "number"
        && typeof v.host === "string"
        && typeof v.url === "string" && v.url !== ""
        && typeof v.startedAt === "number";
}

/**
 * 把 /health 回的 JSON 整理成 {@link ServerAddress}。
 *
 * 没自报的字段（端口、主机、给人看的地址）从"我们刚才探的那个地址"补上：
 * 地址文件可能过期，但探活请求本身连的就是眼下这个后端，那几个值是可靠的。
 */
function addressFromHealth(reported: Record<string, unknown>, target: URL): ServerAddress {
    const port = target.port !== "" ? Number(target.port) : (target.protocol === "https:" ? 443 : 80);
    const basePath = target.pathname.endsWith("/") ? target.pathname : `${target.pathname}/`;
    return {
        app: "pichat",
        version: typeof reported.version === "string" ? reported.version : "",
        pid: typeof reported.pid === "number" ? reported.pid : 0,
        port: typeof reported.port === "number" ? reported.port : port,
        host: typeof reported.host === "string" ? reported.host : target.hostname,
        url: typeof reported.url === "string" && reported.url !== "" ? reported.url : `${target.origin}${basePath}`,
        startedAt: typeof reported.startedAt === "number" ? reported.startedAt : 0,
    };
}
