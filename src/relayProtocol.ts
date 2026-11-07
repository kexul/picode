/**
 * 后端跟「中转」之间那条本机连接上说的话（两个进程各认这一份类型）。
 *
 * 走法：一个 127.0.0.1 的 TCP 连接，一行一条 JSON（跟 pi 的 RPC 一个习惯）。
 * 口令在握手第一条里带上，不对就断开。
 *
 * 为什么会话要这么绕：中转是唯一拿着 pi 管道的进程（见 relayMain.ts）。后端要跟 pi 说话，
 * 只能请它代转；后端换人了（重启），新的连上来接着转就行，pi 那边一根管子都不动。
 */
import type { PiSpawnSpec } from "./piSpawn";

/** relay.json 里记的东西：中转在哪个端口、口令是什么。 */
export interface RelayAddress {
    app: "pichat-relay";
    version: string;
    pid: number;
    port: number;
    token: string;
    startedAt: number;
}

/** 中转手里的一只 pi（后端只读这份，别拿去当唯一真相）。 */
export interface RelayPiInfo {
    /** 中转认的名字（后端换人以后靠它接回去） */
    key: string;
    /** pi 的进程号（日志里对人有用） */
    pid: number;
    /** 它跑在哪个目录 */
    cwd: string;
    /** 这是哪一个会话（后端起的会话 id；中转自己不解释它） */
    panelId?: string;
    /** 当前打开的会话文件（认身份用：重启后新后端照它把会话认回来） */
    sessionFile?: string;
    startedAt: number;
    /** 这个进程已经用掉的请求编号（新后端接着往下数，免得跟旧答复撞号） */
    maxReq: number;
}

/** 后端 → 中转。带 n 的要一条 reply（中转原样把 n 带回来）。 */
export type RelayRequest =
    | { op: "hello"; token: string }
    | { op: "list"; n: number }
    | { op: "spawn"; n: number; key: string; spec: PiSpawnSpec }
    | {
        op: "attach"; n: number; key: string;
        /** 要不要把缓存里这个进程说过的话先补一遍（第一笔先不补：正在流的那半句另算） */
        replay?: boolean;
        /** 补发起点（上一次处理到第几条） */
        since?: number;
    }
    | { op: "send"; key: string; line: string }
    | { op: "label"; key: string; panelId?: string; sessionFile?: string; cwd?: string }
    | { op: "kill"; key: string }
    | { op: "shutdown" };

/** 中转 → 后端。 */
export type RelayEvent =
    | { ev: "hello"; ok: true; version: string; pi: RelayPiInfo[] }
    | { ev: "hello"; ok: false; reason: string }
    | {
        ev: "reply"; n: number; ok: boolean; reason?: string;
        /** spawn / list 回的是一份（list）或一只（spawn / attach） */
        pi?: RelayPiInfo;
        keys?: RelayPiInfo[];
        /** attach 时告诉后端：这个进程已经用掉的请求编号 */
        maxReq?: number;
    }
    | { ev: "frame"; seq: number; key: string; ch: "out" | "err"; line: string }
    | { ev: "exit"; key: string; code: number | null };

export const RELAY_TOKEN_HEADER = "token";
