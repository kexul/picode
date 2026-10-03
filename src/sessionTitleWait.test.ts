/**
 * 会话标题（pi 自己给的那个）与“等标题”逻辑的单测。
 *
 * 用假 pi 进程跑，不 spawn 真的 pi、不弹 Windows 通知：
 * 提醒里的会话名要靠 SessionRuntime 把标题喂过去（见 turnNotifyText），
 * 这里就盯“标题从哪来 / 什么时候不用再等”这两件事。
 */
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { SessionRuntime } from "./sessionRuntime";
import type { PiClient } from "./piClient";
import type { PiConfig, RuntimeHost } from "./runtimeTypes";
import { randomNameParts } from "./names";

/** 假 pi 进程：get_state 回什么由构造时给定，pi 事件由测试自己 emit。 */
class FakePiClient extends EventEmitter {
    public running = false;
    /** 收到的命令（用来确认没有乱发东西）。 */
    public readonly sent: Array<Record<string, unknown>> = [];

    constructor(private readonly stateSessionName?: string) {
        super();
    }

    public start(): void { this.running = true; }
    public stop(): void { this.running = false; }
    public isRunning(): boolean { return this.running; }
    public send(cmd: Record<string, unknown>): void { this.sent.push(cmd); }
    public async waitReady(): Promise<boolean> { return this.running; }
    public async request(cmd: Record<string, unknown>): Promise<unknown> {
        this.sent.push(cmd);
        if (cmd.type === "get_state") {
            return {
                type: "response",
                command: "get_state",
                success: true,
                data: { sessionName: this.stateSessionName, sessionFile: "/tmp/x/fake.jsonl" },
            };
        }
        return { type: "response", command: String(cmd.type), success: true, data: undefined };
    }
}

/** 最小宿主：消息只收集，弹窗一律取消。 */
function fakeHost(spare?: FakePiClient): RuntimeHost {
    const host: Partial<RuntimeHost> = {
        workspaceId: "sidebar",
        getConfig: (): PiConfig => ({ piPath: "pi", provider: "", model: "", extraArgs: [], trustProject: false }),
        getCwd: () => "/tmp/x",
        relativeTo: (_cwd: string, full: string) => full,
        resolvePath: (p: string) => p,
        checkPiAvailable: () => true,
        claimSpareClient: spare ? () => ({ client: spare as unknown as PiClient }) : undefined,
        postToTab: () => { /* 界面上的渲染不是这里的关注点 */ },
        broadcastTabList: () => { /* noop */ },
        onTurnEnd: () => { /* noop */ },
        confirmDialog: async () => false,
        selectDialog: async () => undefined,
        inputDialog: async () => undefined,
        pickModelInteractive: async () => undefined,
        persistModel: () => { /* noop */ },
        openFileLocation: () => { /* noop */ },
        openDiff: () => { /* noop */ },
        confirmRevert: async () => false,
    };
    return host as RuntimeHost;
}

/** 起一个挂着假进程的会话运行时。 */
function makeRuntime(spare?: FakePiClient): SessionRuntime {
    const rt = new SessionRuntime("sidebar:panel-1", randomNameParts(), fakeHost(spare));
    if (spare) { rt.startClient(); }
    return rt;
}

/** 轮询等一个条件成立（最多 timeoutMs），用来等异步的 get_state 回来。 */
async function waitUntil(cond: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}

describe("pi 会话标题", () => {
    it("从 get_state 的 sessionName 读进来（加载已有会话走这条）", async () => {
        const rt = makeRuntime(new FakePiClient("修复登录重定向"));
        await waitUntil(() => rt.sessionTitle === "修复登录重定向");
        assert.equal(rt.sessionTitle, "修复登录重定向");
    });

    it("session_info_changed 事件一到，等标题的提醒立刻拿到它", async () => {
        const client = new FakePiClient();
        const rt = makeRuntime(client);
        assert.equal(rt.sessionTitle, "");
        const waiting = rt.waitForSessionTitle(3000);
        // 自动命名扩展在第一轮跑完后才调 set_session_name，pi 把它转成这个事件
        client.emit("event", { type: "session_info_changed", name: "上传 auto-session-title 插件" });
        assert.equal(await waiting, "上传 auto-session-title 插件");
        assert.equal(rt.sessionTitle, "上传 auto-session-title 插件");
    });

    it("已经有标题时不用再等", async () => {
        const client = new FakePiClient("改构建脚本");
        const rt = makeRuntime(client);
        await waitUntil(() => rt.sessionTitle !== "");
        const t0 = Date.now();
        assert.equal(await rt.waitForSessionTitle(3000), "改构建脚本");
        assert.ok(Date.now() - t0 < 100, "有标题就不该等");
    });

    it("pi 进程不在（没启动 / 已退出）时不干等超时，立刻回落", async () => {
        const notStarted = makeRuntime();
        const t0 = Date.now();
        assert.equal(await notStarted.waitForSessionTitle(3000), "");
        assert.ok(Date.now() - t0 < 200, "进程不在时不该等满 3 秒");

        const client = new FakePiClient();
        const rt = makeRuntime(client);
        rt.stopClient();
        assert.equal(await rt.waitForSessionTitle(3000), "");
    });

    it("会话被换掉（新建会话）时，等旧标题的提醒立刻拿空结果", async () => {
        const rt = makeRuntime(new FakePiClient());
        const waiting = rt.waitForSessionTitle(3000);
        rt.resetSession();
        const t0 = Date.now();
        assert.equal(await waiting, "");
        assert.ok(Date.now() - t0 < 200, "旧标题不会再来，不该继续等");
        assert.equal(rt.sessionTitle, "");
        assert.ok(rt.title, "插件分配的会话显示名始终在，提醒有字可显示");
    });
});
