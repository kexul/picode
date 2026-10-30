/**
 * 自动接着干（/auto）的开关存在哪儿：一个会话一份，键是那个会话的 .jsonl 路径。
 *
 * 为什么不按会话编号存：编号（panel id）每次开、每次重连都不一定一样，
 * 会话文件才是一份会话真正的身份 —— 会话重开、插件重启、换台设备接着看，
 * 只要还是同一份会话文件，开关就认得回来。
 *
 * 文件：<~/.pi/pichat>/auto.json，全部会话装在一个文件里（只记"开着"的那些，一次读写就够）。
 */
import * as fs from "fs";
import * as path from "path";
import { autoFile } from "./serverPaths";
import type { AutoState } from "./auto";

/** 这份存档的格式版本；对不上就当没有（不会把旧格式读成乱七八糟的东西）。 */
export const AUTO_FILE_VERSION = 1;

interface AutoFileData {
    v: number;
    /** 会话文件路径 → 那个会话的开关。 */
    autos: Record<string, AutoState>;
}

function readAll(file: string): AutoFileData {
    const empty: AutoFileData = { v: AUTO_FILE_VERSION, autos: {} };
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return empty;   // 文件还不存在是常态；坏 JSON 也当没有
    }
    if (!parsed || parsed.v !== AUTO_FILE_VERSION || !parsed.autos || typeof parsed.autos !== "object") {
        return empty;
    }
    return { v: AUTO_FILE_VERSION, autos: parsed.autos as Record<string, AutoState> };
}

function writeAll(file: string, data: AutoFileData): boolean {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
        return true;
    } catch (e: any) {
        console.error("[auto] 写开关存档失败:", e?.message ?? e);
        return false;
    }
}

/** 读一个会话的开关；没有、或者存档坏了，返回 undefined。 */
export function readAuto(sessionFile: string, file: string = autoFile()): AutoState | undefined {
    if (!sessionFile) { return undefined; }
    return normalizeAuto(readAll(file).autos[sessionFile]);
}

/** 写一个会话的开关（键是会话文件路径）。 */
export function writeAuto(auto: AutoState, sessionFile: string, file: string = autoFile()): boolean {
    if (!sessionFile) { return false; }
    const data = readAll(file);
    data.autos[sessionFile] = { ...auto, updatedAt: Date.now() };
    return writeAll(file, data);
}

/** 清掉一个会话的开关（点那颗转圈圈的图标、判官说不用继续，都走这里）。 */
export function dropAuto(sessionFile: string, file: string = autoFile()): void {
    if (!sessionFile) { return; }
    const data = readAll(file);
    if (!(sessionFile in data.autos)) { return; }
    delete data.autos[sessionFile];
    writeAll(file, data);
}

/** 存档里读出来的东西不可信：缺字段、类型不对的都补成保守的值。 */
function normalizeAuto(raw: any): AutoState | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
    return {
        rounds: num(raw.rounds),
        ...(note ? { note } : {}),
        updatedAt: num(raw.updatedAt),
    };
}
