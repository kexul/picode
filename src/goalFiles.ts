/**
 * 目标存哪儿：一个会话一份，键是那个会话的 .jsonl 路径。
 *
 * 为什么不按会话编号存：编号（panel id）每次开、每次重连都不一定一样，
 * 会话文件才是一份会话真正的身份 —— 会话重开、插件重启、换台设备接着看，只要还是同一份
 * 会话文件，目标就认得回来（Codex 那边把目标存在线程里，是同一个意思）。
 *
 * 文件：<~/.pi/pichat>/goals.json，全部会话装在一个文件里（目标数量很少，一次读写就够）。
 */
import * as fs from "fs";
import * as path from "path";
import { goalsFile } from "./serverPaths";
import type { GoalPhase, GoalState } from "./goal";

/** 这份存档的格式版本；对不上就当没有（不会把旧格式读成乱七八糟的东西）。 */
export const GOAL_FILE_VERSION = 1;

interface GoalFile {
    v: number;
    /** 会话文件路径 → 那个会话的目标。 */
    goals: Record<string, GoalState>;
}

/** 认得的几个阶段；存档里出现别的一律当"没在跑"（宁可不动，也别拿坏状态去催模型）。 */
const PHASES: GoalPhase[] = ["negotiating", "active", "paused", "complete"];

function readAll(file: string): GoalFile {
    const empty: GoalFile = { v: GOAL_FILE_VERSION, goals: {} };
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return empty;   // 文件还不存在是常态；坏 JSON 也当没有
    }
    if (!parsed || parsed.v !== GOAL_FILE_VERSION || !parsed.goals || typeof parsed.goals !== "object") {
        return empty;
    }
    return { v: GOAL_FILE_VERSION, goals: parsed.goals as Record<string, GoalState> };
}

function writeAll(file: string, data: GoalFile): boolean {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
        return true;
    } catch (e: any) {
        console.error("[goal] 写目标存档失败:", e?.message ?? e);
        return false;
    }
}

/** 读一个会话的目标；没有、或者存档坏了，返回 undefined。 */
export function readGoal(sessionFile: string, file: string = goalsFile()): GoalState | undefined {
    if (!sessionFile) { return undefined; }
    const raw = readAll(file).goals[sessionFile];
    return normalizeGoal(raw);
}

/** 写一个会话的目标（键是会话文件路径）。 */
export function writeGoal(goal: GoalState, sessionFile: string, file: string = goalsFile()): boolean {
    if (!sessionFile) { return false; }
    const data = readAll(file);
    data.goals[sessionFile] = { ...goal, updatedAt: Date.now() };
    return writeAll(file, data);
}

/** 清掉一个会话的目标（/goal 清除 走这里）。 */
export function dropGoal(sessionFile: string, file: string = goalsFile()): void {
    if (!sessionFile) { return; }
    const data = readAll(file);
    if (!(sessionFile in data.goals)) { return; }
    delete data.goals[sessionFile];
    writeAll(file, data);
}

/** 存档里读出来的东西不可信：缺字段、类型不对的都补成保守的值。 */
function normalizeGoal(raw: any): GoalState | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const objective = typeof raw.objective === "string" ? raw.objective : "";
    if (!objective.trim()) { return undefined; }
    const criteria = Array.isArray(raw.criteria)
        ? raw.criteria.filter((c: unknown) => typeof c === "string" && c.trim()).map((c: string) => c.trim())
        : [];
    const phase: GoalPhase = PHASES.indexOf(raw.phase) >= 0 ? raw.phase : "paused";
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
    return {
        objective,
        criteria,
        phase,
        startedAt: num(raw.startedAt),
        rounds: num(raw.rounds),
        ...(note ? { note } : {}),
        updatedAt: num(raw.updatedAt),
    };
}
