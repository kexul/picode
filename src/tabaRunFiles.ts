/**
 * 派子会话（taba）：给模型看的"名录"文件。
 *
 * 为什么要有这个文件：子会话的 .jsonl 在哪只有插件知道（全新会话的文件名是 pi 自己起的，
 * 带上下文那两档是插件自己造的编号），而 pi 进程到插件只有 stderr 那条单向暗号，
 * 插件没法直接回话给工具。所以插件在子会话状态变化时往这里写一份很小的名录，
 * 桥扩展里的 taba_peek 读它，把 .jsonl 的路径交给模型，剩下的让模型自己用 read / bash 去读。
 *
 * 目录：<资源目录>/taba-runs/<子会话编号>.json
 * 里面的内容就是下面的 TabaRunRecord，两边靠 TABA_RUN_FILE_VERSION 认版本。
 */
import * as fs from "fs";
import * as path from "path";
import type { TabaChild } from "./tabaRegistry";

/** 名录文件的格式版本；两边不一致就当作认不出来。 */
export const TABA_RUN_FILE_VERSION = 1;

/** 名录里记的状态：登记表那几个状态，加上"tab 已关闭"。 */
export type TabaRunState = TabaChild["state"] | "closed";

/** 名录文件里的一条记录（桥扩展那边读的就是这个结构）。 */
export interface TabaRunRecord {
    v: number;
    id: string;
    name: string;
    /** 派给它的任务原文，方便模型确认自己看的是不是那一个。 */
    task: string;
    /** 用的角色名（没指名角色就是空串）。 */
    agent: string;
    state: TabaRunState;
    /** 状态的人话说法（插件写好，扩展直接显示，不重复一套文案）。 */
    stateText: string;
    startedAt: number;
    /** 第一轮跑完的时间；还没跑完就是 0。 */
    endedAt: number;
    /** 结果交回去过几次。 */
    deliveries: number;
    /** 会话内容从哪来：standalone / lineage-only / fork。 */
    sessionMode: string;
    /** 子会话的 .jsonl 路径；全新会话在第一条消息落盘以前是空串。 */
    sessionFile: string;
    /** 派活那个会话的 .jsonl 路径；按名字找子会话时靠它确认是不是本会话派的。 */
    parentSessionFile: string;
    /** 子会话最后一条回复的开头一段（省得模型为了看个结论去读大文件）；没有就是空串。 */
    lastReplyPreview: string;
    /** 这份名录的写入时间。 */
    writtenAt: number;
}

/** 名录目录：<资源目录>/taba-runs。 */
export function tabaRunsDir(resourceDir: string): string {
    return path.join(resourceDir, "taba-runs");
}

/** 某个子会话的名录文件路径。 */
export function runFilePath(runsDir: string, id: string): string {
    return path.join(runsDir, `${id}.json`);
}

/** 状态的人话说法（含"tab 已关闭"这一档）。 */
export function runStateText(state: TabaRunState): string {
    switch (state) {
        case "starting": return "正在开";
        case "running": return "运行中";
        case "waiting": return "第一轮跑完了，tab 还留着";
        case "error": return "第一轮出错了";
        case "detached": return "已经变成独立会话";
        case "closed": return "tab 已经关闭";
        default: return String(state);
    }
}

/** 最后一条回复的开头一段：换行压成空格，最长 maxChars 个字，切在词/标点边上。 */
export function makeLastReplyPreview(text: string, maxChars = 200): string {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (!flat) { return ""; }
    if (flat.length <= maxChars) { return flat; }
    let cut = flat.slice(0, maxChars);
    // 尽量别把最后一句切成半句
    const at = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(" "), cut.lastIndexOf("."));
    if (at >= Math.floor(maxChars * 0.5)) { cut = cut.slice(0, at); }
    return cut.trim() + "…";
}

/** 造一条名录记录（不写盘）。 */
export function buildRunRecord(p: {
    child: TabaChild;
    /** 覆盖状态（例如 tab 关掉后登记表已经摘了，名录里写 closed）。 */
    state?: TabaRunState;
    parentSessionFile?: string;
    now?: number;
}): TabaRunRecord {
    const c = p.child;
    const state = p.state ?? c.state;
    return {
        v: TABA_RUN_FILE_VERSION,
        id: c.id,
        name: c.name,
        task: c.task,
        agent: c.agent ?? "",
        state,
        stateText: runStateText(state),
        startedAt: c.startedAt,
        endedAt: c.endedAt ?? 0,
        deliveries: c.deliveries,
        sessionMode: c.sessionMode,
        sessionFile: c.sessionFile ?? "",
        parentSessionFile: p.parentSessionFile ?? c.parentSessionFile ?? "",
        lastReplyPreview: makeLastReplyPreview(c.result ?? ""),
        writtenAt: p.now ?? Date.now(),
    };
}

/** 写一条名录（写不进去就算了，返回是否写成）。 */
export function writeRunRecord(runsDir: string, record: TabaRunRecord): boolean {
    try {
        fs.mkdirSync(runsDir, { recursive: true });
        fs.writeFileSync(runFilePath(runsDir, record.id), JSON.stringify(record), "utf8");
        return true;
    } catch (e: any) {
        console.error("[taba] 写名录文件失败:", e?.message ?? e);
        return false;
    }
}

/** 读一条名录；读不到或版本不对返回 undefined（测试与排查用）。 */
export function readRunRecord(runsDir: string, id: string): TabaRunRecord | undefined {
    try {
        const raw = fs.readFileSync(runFilePath(runsDir, id), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== TABA_RUN_FILE_VERSION) { return undefined; }
        return parsed as TabaRunRecord;
    } catch {
        return undefined;
    }
}

/** 名录最多留多久（毫秒）：默认 7 天。 */
export const TABA_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清掉太老的名录文件（插件激活时调一次）。只按修改时间判断，删不掉的就跳过。
 * @returns 删掉了几个
 */
export function cleanStaleRunFiles(runsDir: string, now = Date.now(), maxAgeMs = TABA_RUN_MAX_AGE_MS): number {
    let names: string[];
    try {
        names = fs.readdirSync(runsDir);
    } catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        if (!name.endsWith(".json")) { continue; }
        const full = path.join(runsDir, name);
        try {
            const st = fs.statSync(full);
            if (now - st.mtimeMs > maxAgeMs) {
                fs.rmSync(full, { force: true });
                removed++;
            }
        } catch { /* 删不掉就算了 */ }
    }
    return removed;
}
