/**
 * 派子会话（taba）端到端编排测试：用假的宿主跑通"派活 → 开新 tab → 发任务 → 结果自动交回"。
 *
 * 不真的起 pi：SessionRuntime 建出来不启动进程，等它就绪 / 发消息 / 中止这几处换成假的，
 * 好把每个环节收到的东西都记下来断言。角色文件、会话文件都写在临时目录里。
 */
import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionRuntime } from "./sessionRuntime";
import { randomNameParts } from "./names";
import type { FileChange, PanelLaunch, PiConfig, TurnEndInfo } from "./runtimeTypes";
import { ChatControllerBase, layoutLeaves, type TabContainer } from "./chatControllerBase";
import { readRunRecord, tabaRunsDir } from "./tabaRunFiles";
import { BrowserChatController, type BrowserChatOwner } from "./browserChatController";

/** 记下每个 panel 都收到了什么。 */
class TabaTestController extends ChatControllerBase {
    public readonly posted: Array<Record<string, unknown>> = [];
    public readonly launches: PanelLaunch[] = [];
    public readonly modelOverrides: Array<{ provider?: string; modelId?: string } | undefined> = [];
    /** panelId → 发过去的消息文本（handleSend）。 */
    public readonly sent = new Map<string, string[]>();
    public readonly aborts: string[] = [];
    /** panelId → getLastAssistantText 假装返回什么。 */
    public readonly lastText = new Map<string, string>();
    public tabaDir = "";
    public readyResult = true;

    constructor(workspaceId: string) { super(workspaceId); }

    protected override createPanelRuntime(_inherited?: { provider?: string; modelId?: string }, launch?: PanelLaunch): SessionRuntime {
        const id = `${this.workspaceId}:panel-${++this.panelSeq}`;
        const rt = new SessionRuntime(id, randomNameParts(), this);
        this.panels.set(id, rt);
        // 故意不 startClient：下面把要观察的几个方法换成假的
        (rt as any).waitReady = async () => this.readyResult;
        (rt as any).handleSend = (text: string) => {
            const list = this.sent.get(id) ?? [];
            list.push(text);
            this.sent.set(id, list);
        };
        (rt as any).abortActiveRun = () => { this.aborts.push(id); };
        (rt as any).getLastAssistantText = async () => this.lastText.get(id) ?? "";
        return rt;
    }

    protected override createBackgroundTab(launch: PanelLaunch, modelOverride?: { provider?: string; modelId?: string }) {
        this.launches.push(launch);
        this.modelOverrides.push(modelOverride);
        return super.createBackgroundTab(launch, modelOverride);
    }

    public override resolveExecutable(cmd: string): string | undefined { return cmd; }

    /** 测试里不预热备用进程（那是真的会起一个 pi）。 */
    protected override ensureSpare(): void { /* noop */ }
    protected override disposeSpare(): void { /* noop */ }

    /** 登记表在基类里是 protected，测试从这两个口子看。 */
    public childOf(panelId: string) { return this.taba.byChildPanel(panelId); }
    public allChildren() { return this.taba.all(); }

    public registryPanels() { return this.panels; }
    public tabs(): string[] { return Array.from(this.tabContainers.keys()); }
    public activeTab(): string | undefined { return this.activeTabId; }
    public leavesOf(containerId: string): string[] {
        const c = this.tabContainers.get(containerId);
        return c ? layoutLeaves(c.root) : [];
    }
    /** 最后一次广播的 tabList。 */
    public lastTabList(): any {
        const lists = this.posted.filter((m) => m.type === "tabList");
        return lists.length ? lists[lists.length - 1] : undefined;
    }
    /** 某个 panel 收到的某一类消息。 */
    public messages(panelId: string, type: string): any[] {
        return this.posted.filter((m) => m.tabId === panelId && m.type === type);
    }

    protected postToWebview(msg: Record<string, unknown>): void { this.posted.push(msg); }
    public getConfig(): PiConfig {
        return {
            piPath: "pi", provider: "", model: "", extraArgs: [], trustProject: true,
            tabaExtension: path.join(this.tabaDir, "taba-bridge-0.0.7.ts"),
            tabaDir: this.tabaDir,
        };
    }
    public getCwd(): string { return this.tabaDir; }
    public resolvePath(p: string): string { return path.isAbsolute(p) ? p : path.join(this.tabaDir, p); }
    public relativeTo(_cwd: string, full: string): string { return full; }
    public async confirmDialog(): Promise<boolean> { return false; }
    public async selectDialog(): Promise<string | undefined> { return undefined; }
    public async inputDialog(): Promise<string | undefined> { return undefined; }
    public persistModel(): void { /* noop */ }
    public openFileLocation(): void { /* noop */ }
    public openDiff(_c: FileChange): void { /* noop */ }
    public async confirmRevert(): Promise<boolean> { return false; }
    protected getAutoLoadLast(): boolean { return false; }
    protected getSendKey(): string { return "enter"; }
    protected getNewSessionKey(): string { return "ctrl+alt+n"; }
    protected getTabSwitchKey(): string { return "ctrl+alt+arrows"; }
    protected getFocusInputKey(): string { return "ctrlAltI"; }
    protected getRelayPrefix(): string { return ""; }
    protected getToolDisplay(): string { return "compact"; }
    protected getFontSize(): string { return "14"; }
    protected mutateViewOption(): void { /* noop */ }
    protected notifyBeepEnabled(): boolean { return false; }
    public readonly notified: TurnEndInfo[] = [];
    protected notifyTurnEnd(info: TurnEndInfo): void { this.notified.push(info); }
    protected sendFileList(): void { /* noop */ }
    protected openFileFromWebview(): void { /* noop */ }
    protected handlePlatformMessage(): boolean { return false; }
}

let tmp = "";
/** 临时目录 + 一份角色文件（写盘那部分走真代码）。 */
before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-taba-flow-"));
    fs.mkdirSync(path.join(tmp, "taba-roles"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "taba-bridge-0.0.7.ts"), "// 假的桥扩展\n", "utf8");
    fs.writeFileSync(path.join(tmp, "taba-roles", "scout.md"), [
        "---",
        "name: scout",
        "description: 只读摸底",
        "tools: read, bash",
        "thinking: low",
        "---",
        "",
        "# 侦察角色",
        "",
        "你是摸底角色，只读不写。",
        "",
    ].join("\n"), "utf8");
    // 子会话文件默认写到 ~/.pi/agent/sessions/…，测试里改到临时目录，别弄脏真的会话目录
    process.env.PI_CODING_AGENT_DIR = tmp;
});

after(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** 开一个控制器 + 一个"派活的会话"（父 panel）。 */
function setup(): { c: TabaTestController; parent: string; parentTab: string } {
    const c = new TabaTestController("test");
    c.tabaDir = tmp;
    const tab = c.newTab();
    const parent = layoutLeaves(tab.root)[0];
    // 假装这个会话正在用某个模型（子会话没指定时会继承它）
    (c.registryPanels().get(parent) as any).statusModelId = "glm-5.3-flash";
    (c.registryPanels().get(parent) as any).statusProvider = "local";
    c.posted.length = 0;
    return { c, parent, parentTab: tab.id };
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
    kind: "spawn" as const, id: "kid1", name: "侦察: 认证", task: "看看认证模块", parentSessionFile: "", ...over,
});

/** 让某个 panel 的一轮跑完（照 SessionRuntime 收尾时给宿主的东西发）。 */
function turnEnd(c: TabaTestController, panelId: string, lastReplyText: string, status: "done" | "error" | "cancelled" = "done"): void {
    c.onTurnEnd({
        panelId, panelName: "子会话", tabName: "", workspaceId: "test", status, lastReplyText,
    });
}

test("派活：新开一个 tab，不抢当前焦点，任务发过去，两边都有提示", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ agent: "scout" }) as any);
    await new Promise((r) => setTimeout(r, 60));

    const tabs = c.tabs();
    assert.equal(tabs.length, 2, "多了一个 tab");
    assert.equal(c.activeTab(), parentTab, "焦点还留在原来那个 tab 上");

    const childTab = tabs.find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];
    const kid = c.childOf(child);
    assert.ok(kid, "子会话登记上了");
    assert.equal(kid!.name, "侦察: 认证");
    assert.equal(kid!.parentPanelId, parent);
    assert.equal(kid!.state, "running", "任务已经发出去了");
    assert.equal(kid!.agent, "scout");
    assert.equal(kid!.sessionMode, "standalone", "角色没写 session-mode，就是全新会话");

    // 子会话的启动参数：角色定的工具白名单、不给它加载桥扩展、不用备用进程
    assert.equal(c.launches.length, 1);
    assert.deepEqual(c.launches[0].extraArgs, ["--tools", "read,bash"]);
    assert.equal(c.launches[0].noTaba, true);
    assert.equal(c.launches[0].skipSpare, true);
    assert.deepEqual(c.modelOverrides[0], { provider: "local", modelId: "glm-5.3-flash:low" }, "角色没写模型，跟着父会话走；思考强度用角色定的");

    // 任务文本：角色正文 + 任务 + 收尾要求；技能那一段没有
    const task = (c.sent.get(child) ?? [])[0];
    assert.ok(task, "任务发到子会话了");
    assert.ok(task.includes("你是摸底角色，只读不写。"), "角色说明跟任务一起发");
    assert.ok(task.includes("看看认证模块"));
    assert.ok(task.includes("最后一条回复会被自动送回"));

    // 父会话那边有一行提示，子会话那边有一行开场提示
    const parentNotice = c.messages(parent, "system").map((m) => String(m.text)).join("\n");
    assert.ok(parentNotice.includes("已派出子会话「侦察: 认证」"), parentNotice);
    assert.ok(parentNotice.includes("全新会话"));
    const childNotice = c.messages(child, "system").map((m) => String(m.text)).join("\n");
    assert.ok(childNotice.includes("由「"), childNotice);

    // tabList 里两个 tab 都带上了子会话信息
    const list = c.lastTabList();
    const childEntry = list.tabs.find((t: any) => t.id === childTab);
    assert.equal(childEntry.taba.role, "child");
    assert.equal(childEntry.taba.parentTabId, parentTab);
    assert.equal(childEntry.name, "侦察: 认证", "子会话 tab 用自己那个活名");
    const parentEntry = list.tabs.find((t: any) => t.id === parentTab);
    assert.equal(parentEntry.taba.role, "parent");
    assert.equal(parentEntry.taba.children.length, 1);
});

test("结果自动交回：只在第一轮跑完时交一次，之后用户接管就不再自动交", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq() as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];

    turnEnd(c, child, "看完了，认证在 src/auth.ts。");
    const toParent = (c.sent.get(parent) ?? []).join("\n");
    assert.ok(toParent.includes("【子会话「侦察: 认证」跑完了"), toParent);
    assert.ok(toParent.includes("看完了，认证在 src/auth.ts。"));
    assert.equal(c.childOf(child)!.deliveries, 1);
    assert.equal(c.childOf(child)!.state, "waiting");

    c.sent.clear();
    turnEnd(c, child, "用户接着问的那一轮");
    assert.equal((c.sent.get(parent) ?? []).length, 0, "第二轮不再自动交回");
    assert.equal(c.childOf(child)!.deliveries, 1);
});

test("子会话没跑成（报错/被中止）也照样交回，别让父会话一直等", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "e1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    turnEnd(c, child, "干了一半", "cancelled");
    const toParent = (c.sent.get(parent) ?? []).join("\n");
    assert.ok(toParent.includes("没有正常跑完（被中止了）"), toParent);
    assert.ok(toParent.includes("干了一半"));
    assert.equal(c.childOf(child)!.state, "error");
});

test("pi 没起来：登记成出错，把这件事交回父会话", async () => {
    const { c, parent, parentTab } = setup();
    c.readyResult = false;
    c.onTabaRequest(parent, spawnReq({ id: "r1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];
    assert.equal((c.sent.get(child) ?? []).length, 0, "没起来就不发任务");
    assert.equal(c.messages(child, "systemError").length, 1);
    const toParent = (c.sent.get(parent) ?? []).join("\n");
    assert.ok(toParent.includes("没有正常跑完"), toParent);
});

test("手动交回：界面上点一下，把最后一条回复再交一次", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "m1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    c.lastText.set(child, "又补了一句结论。");
    c.sent.clear();
    await c.tabaDeliverManual(child);
    const toParent = (c.sent.get(parent) ?? []).join("\n");
    assert.ok(toParent.includes("又补了一句结论。"), toParent);
    assert.ok(toParent.includes("用户手动交的"));
    assert.equal(c.childOf(child)!.deliveries, 1);
    assert.equal(c.messages(child, "system").some((m) => String(m.text).includes("结果已交回")), true);
});

test("指名停止：只停子会话当前这一轮", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "s1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];

    c.onTabaRequest(parent, { kind: "stop", id: "s1" } as any);
    assert.deepEqual(c.aborts, [child]);
    assert.ok(c.messages(child, "system").some((m) => String(m.text).includes("停下当前这一轮")));

    // 按名字也能停；不是自己派的停不了
    c.aborts.length = 0;
    c.onTabaRequest(parent, { kind: "stop", name: "侦察" } as any);
    assert.deepEqual(c.aborts, [child]);
    c.aborts.length = 0;
    c.sent.clear();
    c.onTabaRequest(parent, { kind: "stop", name: "别人的子会话" } as any);
    assert.deepEqual(c.aborts, []);
    assert.ok((c.sent.get(parent) ?? []).join("\n").includes("【停子会话没成】"));
});

test("同一个派活编号重复送过来只开一个 tab", async () => {
    const { c, parent } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "dup" }) as any);
    c.onTabaRequest(parent, spawnReq({ id: "dup" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.tabs().length, 2, "只多了一个 tab");
});

test("角色不存在：不开 tab，把原因交回父会话", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "bad", agent: "没有这个角色" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(c.tabs(), [parentTab], "没有多开 tab");
    const toParent = (c.sent.get(parent) ?? []).join("\n");
    assert.ok(toParent.includes("【派子会话没成】"), toParent);
    assert.ok(toParent.includes("没有叫「没有这个角色」这个角色"));
    assert.ok(c.messages(parent, "system").some((m) => String(m.text).includes("没派出去")));
});

test("带上上下文：先写一个子会话文件，用 --session 打开它", async () => {
    const { c, parent, parentTab } = setup();
    // 父会话已经落盘的文件
    const parentSession = path.join(tmp, "parent-session.jsonl");
    const line = (o: unknown) => JSON.stringify(o);
    const parentLines = [
        line({ type: "session", version: 3, id: "parent-id", cwd: tmp }),
        line({ type: "message", id: "m1", parentId: "parent-id", message: { role: "user", content: [{ type: "text", text: "第一句" }] } }),
        line({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } }),
        line({ type: "message", id: "m3", parentId: "m2", message: { role: "user", content: [{ type: "text", text: "派活那一句" }] } }),
    ];
    fs.writeFileSync(parentSession, parentLines.join("\n") + "\n", "utf8");

    c.onTabaRequest(parent, spawnReq({ id: "fork1", fork: true, parentSessionFile: parentSession }) as any);
    await new Promise((r) => setTimeout(r, 120));

    const args = c.launches[0].extraArgs!;
    const at = args.indexOf("--session");
    assert.ok(at >= 0, "带上了 --session");
    const file = args[at + 1];
    assert.ok(fs.existsSync(file), "子会话文件写出来了: " + file);
    const written = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(written[0].type, "session");
    assert.equal(written[0].parentSession, parentSession, "记着父会话是谁");
    assert.equal(written.length, 3, "会话头 + 派活之前那两条");
    assert.equal(written.some((w) => w.type === "session" && w.id === "parent-id"), false, "父会话的头没带过去");
    assert.equal(written.some((w: any) => w.message?.content?.[0]?.text === "派活那一句"), false, "派活那一句没带过去");

    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    assert.equal(c.childOf(child)!.sessionMode, "fork");
    assert.ok(c.messages(parent, "system").some((m) => String(m.text).includes("带上了本会话之前的对话")));
});

test("父会话还没落盘时：退回全新会话，并在提示里说清楚", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "nofile", fork: true, parentSessionFile: path.join(tmp, "不存在.jsonl") }) as any);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.launches[0].extraArgs!.includes("--session"), false);
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    assert.equal(c.childOf(child)!.sessionMode, "fork", "模式还是 fork，只是没带上");
    assert.ok(c.messages(parent, "system").some((m) => String(m.text).includes("没能带上这个会话之前的对话")));
});

test("角色说明走系统提示词时，写成文件传给 pi，任务里不重复", async () => {
    const roleDir = path.join(tmp, "taba-roles");
    const file = path.join(roleDir, "writer.md");
    fs.writeFileSync(file, [
        "---",
        "name: writer",
        "description: 写文档",
        "system-prompt: append",
        "---",
        "",
        "你是写文档的角色。",
        "",
    ].join("\n"), "utf8");
    try {
        const { c, parent, parentTab } = setup();
        c.onTabaRequest(parent, spawnReq({ id: "sp1", agent: "writer", task: "写个说明" }) as any);
        await new Promise((r) => setTimeout(r, 60));
        const args = c.launches[0].extraArgs!;
        const at = args.indexOf("--append-system-prompt");
        assert.ok(at >= 0, "带上了 --append-system-prompt");
        assert.ok(fs.existsSync(args[at + 1]), "提示词文件写出来了");
        assert.ok(fs.readFileSync(args[at + 1], "utf8").includes("你是写文档的角色。"));
        const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
        const task = (c.sent.get(child) ?? [])[0];
        assert.equal(task.includes("你是写文档的角色。"), false, "任务里不重复角色说明");
        assert.ok(task.includes("写个说明"));
        // 关掉子 tab 会把这个临时文件删掉
        c.closeTab(c.tabs().find((t) => t !== parentTab)!);
        assert.equal(fs.existsSync(args[at + 1]), false);
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test("派活的会话关掉了：子会话变成独立会话，不再自动交回", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "orphan" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];

    c.closeTab(parentTab);
    assert.equal(c.childOf(child)!.state, "detached");
    assert.equal(c.childOf(child)!.parentPanelId, undefined);
    assert.ok(c.messages(child, "system").some((m) => String(m.text).includes("你现在是独立会话")));
    c.sent.clear();
    turnEnd(c, child, "跑完了");
    assert.equal((c.sent.get(parent) ?? []).length, 0, "父会话已经没了，不会往那儿发");
});

test("子会话的 tab 被关掉、结果还没交回：给父会话补一句", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "closed1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];
    c.sent.clear();
    c.closeTab(childTab);
    const toParent = (c.sent.get(parent) ?? []).join("\n");
    assert.ok(toParent.includes("tab 被关掉了，没有交回结果"), toParent);
    assert.ok(toParent.includes("第一轮还没跑完"));
    assert.equal(c.allChildren().length, 0, "登记摘掉了");
});

test("变成独立会话：界面上点一下就不再往父会话交", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "detach1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];
    c.tabaDetachChild(child);
    assert.equal(c.childOf(child)!.state, "detached");
    assert.ok(c.messages(parent, "system").some((m) => String(m.text).includes("改成了独立会话")));
    c.sent.clear();
    turnEnd(c, child, "跑完了");
    assert.equal((c.sent.get(parent) ?? []).length, 0, "不会再自动交回");
});

test("界面上的按钮：交回、打开父会话、切成子会话的 tab", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "ui1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];

    c.tabaOpenTab(childTab, child);
    assert.equal(c.activeTab(), childTab);
    c.tabaGoParent(child);
    assert.equal(c.activeTab(), parentTab);
});

test("子会话不能再往下派：它的 tab 不加载桥扩展", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "nest" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    // 就算子会话那边冒出派活请求（不该发生），登记上也不会认它的父 panel
    const tabsBefore = c.tabs().length;
    c.onTabaRequest(child, spawnReq({ id: "nest2" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.tabs().length, tabsBefore, "子会话派不出下一个");
});

/** 读某个子会话的名录文件（就是模型那边 taba_peek 读的那份）。 */
function runFile(id: string) {
    return readRunRecord(tabaRunsDir(tmp), id);
}

test("名录文件：派出去就写，状态一变就更新", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "peek1", task: "看看认证模块" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    const child = c.leavesOf(childTab)[0];

    let rec = runFile("peek1");
    assert.ok(rec, "派出去以后名录就写出来了");
    assert.equal(rec!.name, "侦察: 认证");
    assert.equal(rec!.task, "看看认证模块");
    assert.equal(rec!.state, "running");
    assert.equal(rec!.stateText, "运行中");
    assert.equal(rec!.sessionMode, "standalone");
    assert.equal(rec!.deliveries, 0);
    assert.equal(rec!.lastReplyPreview, "", "还没结论就没有预览");
    assert.equal(rec!.sessionFile, "", "假进程不会落盘，所以路径还是空的");
    assert.ok(rec!.startedAt > 0);

    turnEnd(c, child, "结论：认证逻辑集中在 src/auth.ts。");
    rec = runFile("peek1");
    assert.equal(rec!.state, "waiting");
    assert.equal(rec!.deliveries, 1);
    assert.equal(rec!.lastReplyPreview, "结论：认证逻辑集中在 src/auth.ts。");
    assert.ok(rec!.endedAt >= rec!.startedAt);
});

test("名录文件：用户在子会话里接管了，「最后一条回复的开头」也跟着更新（但不再自动交回）", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "peek6" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];

    turnEnd(c, child, "第一轮的结论。");
    assert.equal(runFile("peek6")!.lastReplyPreview, "第一轮的结论。");
    assert.equal(runFile("peek6")!.deliveries, 1);

    c.sent.clear();
    turnEnd(c, child, "接管之后又补的新结论，比刚才那段长一些。");
    const rec = runFile("peek6")!;
    assert.equal(rec.lastReplyPreview, "接管之后又补的新结论，比刚才那段长一些。", "名录要跟上");
    assert.equal(rec.deliveries, 1, "不再自动交回");
    assert.equal((c.sent.get(parent) ?? []).length, 0, "父会话没有再收到东西");
    assert.equal(rec.state, "waiting");
});

test("名录文件：接管后那一轮出错了，也不该把已有结论擦掉", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "peek7" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    turnEnd(c, child, "第一轮的结论。");
    turnEnd(c, child, "", "error");
    assert.equal(runFile("peek7")!.lastReplyPreview, "第一轮的结论。");
});

test("名录文件：带上下文那档写的就是我们造出来的那个会话文件", async () => {
    const { c, parent, parentTab } = setup();
    const parentSession = path.join(tmp, "parent-for-peek.jsonl");
    fs.writeFileSync(parentSession, JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "第一句" }] } }) + "\n", "utf8");
    c.onTabaRequest(parent, spawnReq({ id: "peek2", fork: true, parentSessionFile: parentSession }) as any);
    await new Promise((r) => setTimeout(r, 120));

    const args = c.launches[c.launches.length - 1].extraArgs!;
    const seeded = args[args.indexOf("--session") + 1];
    const rec = runFile("peek2");
    assert.ok(rec);
    assert.equal(rec!.sessionMode, "fork");
    assert.equal(rec!.sessionFile, seeded, "名录里给的就是子会话那个 .jsonl");
    assert.equal(rec!.parentSessionFile, parentSession, "按名字找子会话时靠它认是不是本会话派的");
    assert.ok(fs.existsSync(seeded));
});

test("名录文件：子 tab 关掉后还在，写成 tab 已关闭", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "peek3" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const childTab = c.tabs().find((t) => t !== parentTab)!;
    c.closeTab(childTab);

    const rec = runFile("peek3");
    assert.ok(rec, "名录留着，事后还能查到路径");
    assert.equal(rec!.state, "closed");
    assert.equal(rec!.stateText, "tab 已经关闭");
    assert.equal(c.childOf(c.leavesOf(childTab)[0]), undefined, "登记表里已经摘掉了");
});

test("名录文件：变成独立会话后跟着改状态，父会话路径留着", async () => {
    const { c, parent, parentTab } = setup();
    const parentSession = path.join(tmp, "parent-detach.jsonl");
    fs.writeFileSync(parentSession, "{}\n", "utf8");
    c.onTabaRequest(parent, spawnReq({ id: "peek4", parentSessionFile: parentSession }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];
    c.tabaDetachChild(child);

    const rec = runFile("peek4");
    assert.equal(rec!.state, "detached");
    assert.equal(rec!.stateText, "已经变成独立会话");
    assert.equal(rec!.parentSessionFile, parentSession, "原来那个会话仍然能按名字找到它");
});

test("收尾提醒：子会话跑完不发系统通知；变成独立之后就照常提醒", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "n1" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    const child = c.leavesOf(c.tabs().find((t) => t !== parentTab)!)[0];

    turnEnd(c, child, "看完了。");
    assert.equal(c.notified.length, 0, "子会话跑完不发系统通知");

    // 用户接管：变成独立会话之后，它就是自己的会话了，照常提醒
    c.tabaDetachChild(child);
    turnEnd(c, child, "独立之后又跑完一轮。");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(c.notified.length, 1, "独立会话照常提醒");
    assert.equal(c.notified[0].panelId, child);
});

test("浏览器那份的配置：派子会话的两项原样透传，不再清空", () => {
    const cfg: PiConfig = {
        piPath: "pi",
        provider: "",
        model: "",
        extraArgs: [],
        trustProject: true,
        tabaExtension: path.join(tmp, "taba-bridge-test.ts"),
        tabaDir: tmp,
    };
    // 这次只走配置和登记这两个口子，宿主其余成员不会被碰到
    const owner = {
        getConfig: () => cfg,
        getCwd: () => tmp,
        registerExternalWorkspace: () => {},
        unregisterExternalWorkspace: () => {},
    } as unknown as BrowserChatOwner;
    const c = new BrowserChatController(owner);
    try {
        assert.equal(c.getConfig().tabaExtension, cfg.tabaExtension);
        assert.equal(c.getConfig().tabaDir, cfg.tabaDir);
    } finally {
        c.dispose();
    }
});

test("名录文件：派活的会话关掉了，子会话那份也改成独立", async () => {
    const { c, parent, parentTab } = setup();
    c.onTabaRequest(parent, spawnReq({ id: "peek5" }) as any);
    await new Promise((r) => setTimeout(r, 60));
    c.closeTab(parentTab);
    const rec = runFile("peek5");
    assert.equal(rec!.state, "detached");
});
