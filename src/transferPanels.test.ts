/**
 * transferPanels 单元测试：panel 在两个工作区之间的“活体移交”
 * （detachPanelsForTransfer / adoptPanels）——布局保持、id 重映射、空 tab 复用。
 *
 * 用不启动 pi 的 SessionRuntime（无 client）跑纯编排逻辑：
 * replayHistory 在 client 缺失时只推一条 system 消息即返回。
 */
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { SessionRuntime } from "./sessionRuntime";
import { randomNameParts } from "./names";
import type { FileChange, PiConfig } from "./runtimeTypes";
import {
    ChatControllerBase,
    layoutLeaves,
    type TabContainer,
    type TransferPayload,
} from "./chatControllerBase";

/** 最小宿主：不 spawn pi、消息只收集不发送。 */
class TestController extends ChatControllerBase {
    public readonly posted: Array<Record<string, unknown>> = [];

    constructor(workspaceId: string) { super(workspaceId); }

    protected override createPanelRuntime(): SessionRuntime {
        const id = `${this.workspaceId}:panel-${++this.panelSeq}`;
        const rt = new SessionRuntime(id, randomNameParts(), this);
        this.panels.set(id, rt);
        return rt; // 故意不 startClient
    }

    public tabs(): Array<{ id: string; leaves: string[]; focus?: string }> {
        return Array.from(this.tabContainers.values()).map((c: TabContainer) => ({
            id: c.id, leaves: layoutLeaves(c.root), focus: c.focusPanelId,
        }));
    }
    public panelIds(): string[] { return Array.from(this.panels.keys()); }
    /** 布局树原样取出（校验结构是否被完整带走）。 */
    public rootOf(containerId: string) { return this.tabContainers.get(containerId)?.root; }

    protected postToWebview(msg: Record<string, unknown>): void { this.posted.push(msg); }
    public getConfig(): PiConfig {
        return { piPath: "pi-does-not-exist", provider: "", model: "", extraArgs: [], trustProject: false };
    }
    public getCwd(): string { return "/tmp/x"; }
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
    protected sendFileList(): void { /* noop */ }
    protected openFileFromWebview(): void { /* noop */ }
    protected handlePlatformMessage(): boolean { return false; }
}

/** 源工作区：tab1 = 两个 panel 分屏，tab2 = 单 panel。 */
function buildSource(): { src: TestController; tab1: string; tab2: string; panels1: string[]; panel2: string } {
    const src = new TestController("src");
    const c1 = src.newTab();
    const first = layoutLeaves(c1.root)[0];
    src.addPanel(first);
    const c2 = src.newTab();
    return {
        src,
        tab1: c1.id,
        tab2: c2.id,
        panels1: src.panelsOfContainer(c1.id),
        panel2: src.panelsOfContainer(c2.id)[0],
    };
}

describe("detachPanelsForTransfer", () => {
    it("整个 tab：布局树原样带走，源容器消失", () => {
        const { src, tab1, tab2, panels1 } = buildSource();
        const payload = src.detachPanelsForTransfer(panels1);
        assert.ok(payload);
        assert.equal(payload!.runtimes.length, 2);
        assert.deepEqual(layoutLeaves(payload!.root), panels1); // 分屏结构保留
        assert.equal(payload!.root.kind, "split");
        assert.equal(src.hasChatReference(tab1), false);
        assert.deepEqual(src.tabs().map((t) => t.id), [tab2]);
        assert.equal(src.panelIds().includes(panels1[0]), false);
        // 进程与名字都还在运行时对象上（不是杀掉重建）
        const rt = payload!.runtimes[0];
        assert.ok(rt.title.length > 0);
    });

    it("单个 panel：从多 panel tab 里摘出，同 tab 其余 panel 留下", () => {
        const { src, tab1, panels1 } = buildSource();
        const payload = src.detachPanelsForTransfer([panels1[0]]);
        assert.ok(payload);
        assert.deepEqual(payload!.root, { kind: "panel", panelId: panels1[0] });
        assert.deepEqual(src.panelsOfContainer(tab1), [panels1[1]]);
        assert.equal(payload!.focusPanelId, panels1[0]);
    });

    it("搬空后源工作区自动补一个空 tab", () => {
        const { src, panel2 } = buildSource();
        src.closeTab(src.tabs()[0].id);
        const payload = src.detachPanelsForTransfer([panel2]);
        assert.ok(payload);
        assert.equal(src.tabs().length, 1); // 补的空 tab
        assert.notEqual(src.tabs()[0].leaves[0], panel2);
    });

    it("panel 已不存在 / 粒度不支持 → undefined，且不动源布局", () => {
        const { src, tab1, panels1 } = buildSource();
        assert.equal(src.detachPanelsForTransfer(["nope"]), undefined);
        assert.equal(src.detachPanelsForTransfer([panels1[0], "nope"]), undefined);
        assert.deepEqual(src.panelsOfContainer(tab1), panels1);
    });
});

describe("adoptPanels", () => {
    it("panel id 换成目标工作区前缀，宿主换绑到目标", async () => {
        const { src, panels1 } = buildSource();
        const dst = new TestController("dst");
        const payload = src.detachPanelsForTransfer(panels1)!;
        await dst.adoptPanels(payload);
        const tab = dst.tabs()[0];
        assert.ok(tab.id.startsWith("dst:tab-"));
        assert.equal(tab.leaves.length, 2);
        assert.ok(tab.leaves.every((id) => id.startsWith("dst:panel-")));
        assert.deepEqual(dst.panelIds(), tab.leaves);
        // 焦点跟过去（源 tab 的 focusPanelId 一并映射）
        assert.ok(tab.focus && tab.leaves.includes(tab.focus));
        // 重放消息进了目标 webview
        assert.ok(dst.posted.some((m) => m.type === "tabList"));
        assert.ok(dst.posted.some((m) => m.type === "tabActivated" && m.id === tab.id));
    });

    it("空的活跃 tab 被复用（新建工作区首屏不留空 tab）", async () => {
        const { src, panels1 } = buildSource();
        const dst = new TestController("dst");
        dst.newTab(); // ready 时建的空 tab
        const before = dst.panelIds();
        assert.equal(before.length, 1);
        await dst.adoptPanels(src.detachPanelsForTransfer(panels1)!);
        assert.equal(dst.tabs().length, 1);
        assert.equal(dst.panelIds().length, 2); // 空 panel 已被丢弃，只剩迁入的两个
        assert.equal(dst.panelIds().includes(before[0]), false);
    });

    it("目标已有非空 tab 时新建 tab 承载，不影响原有会话", async () => {
        const { src, panel2 } = buildSource();
        const dst = new TestController("dst");
        dst.newTab();
        dst.getActive()!.loading = true; // 伪装成有内容（非空 tab）
        const existing = dst.panelIds()[0];
        await dst.adoptPanels(src.detachPanelsForTransfer([panel2])!);
        assert.equal(dst.tabs().length, 2);
        assert.equal(dst.panelIds().includes(existing), true);
        assert.deepEqual(dst.tabs()[1].leaves.length, 1);
    });

    it("两个工作区来回搬：布局与运行时对象始终是同一个实例", async () => {
        const { src, panels1 } = buildSource();
        const dst = new TestController("dst");
        const payload1: TransferPayload = src.detachPanelsForTransfer(panels1)!;
        const rt = payload1.runtimes[0];
        await dst.adoptPanels(payload1);
        const movedId = dst.panelIds()[0];
        const back = dst.detachPanelsForTransfer(dst.panelsOfContainer(dst.tabs()[0].id))!;
        // 回到源工作区时是同一批运行时对象（进程没换过）
        assert.ok(back.runtimes.includes(rt));
        // 源剩下的 tab 标为非空，免得被当成可复用空 tab
        src.getActive()!.loading = true;
        await src.adoptPanels(back);
        assert.equal(src.panelIds().includes(movedId), false); // id 已重映射回 src 命名空间
        assert.equal(src.tabs().length, 2);                    // 原有 tab + 搬回来的 tab
        assert.ok(src.panelIds().every((id) => id.startsWith("src:panel-")));
    });
});
