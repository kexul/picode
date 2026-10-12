import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ServerChatHost } from "./serverChatHost";
import { updateServerConfig } from "./serverConfig";

/**
 * 每块屏各自看哪个会话：把真后端（ServerChatHost）拉起来，屏用真消息喂进去，
 * 只看协议上发出去的东西（sessionActivated / sessionList）。
 *
 * 会话进程是真起的（pi 指到 dev/fake-pi，不调模型），所以每段测试收摊都要 dispose，
 * 不然假 pi 进程会留在那儿。
 */

/** 假 pi 的路径：命令行启动要用得着（Windows 上必须是 .cmd 那样能被 shell 起的）。 */
const FAKE_PI = path.join(
    __dirname, "..", "..", "dev",
    process.platform === "win32" ? "fake-pi.cmd" : "fake-pi.sh",
);

let seq = 0;

/** 临时目录（每个测试一套，互不打扰）。 */
function tempDir(tag: string): string {
    const dir = path.join(os.tmpdir(), `pichat-focus-${process.pid}-${++seq}-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** 一套临时后端：默认目录 = work，pi 指到假的，设置写在临时目录里。 */
function backend(work: string): { host: ServerChatHost; stop: () => void } {
    const dir = tempDir("cfg");
    updateServerConfig({ piPath: FAKE_PI, autoLoadLast: false }, dir);
    const host = new ServerChatHost({ cwd: work, dir, log: () => { /* 测试里不看日志 */ } });
    return {
        host,
        stop: () => {
            host.dispose();
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
        },
    };
}

/** 一块屏（一个 VSCode 窗口 / 一个浏览器页面）：连上、领页面标识、把发给它的消息记下来。 */
function openScreen(
    host: ServerChatHost,
    screenId: string,
    folders: string[],
): { pageId: string; seen: any[] } {
    host.attachScreen(screenId, folders, () => { /* 派给窗口的活，这里不看 */ });
    const pageId = (host.processScreenMessage({ type: "newPage" }, screenId) as any).pageId as string;
    const seen: any[] = [];
    // 页面那条推送线平时由网页服务接上；测试里自己接一条，好把发给这块屏的消息收下来
    host.getBroadcaster().addChannel(pageId, (msg) => { seen.push(msg); }, () => { /* 不断开 */ });
    return { pageId, seen };
}

/** 等一个条件成立（不成立就按时抛错）。 */
async function waitFor<T>(probe: () => T | undefined | false, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) { return value; }
        if (Date.now() > deadline) { throw new Error(`等超时了：${what}`); }
        await new Promise((r) => setTimeout(r, 200));
    }
}

/** 这块屏收到的 sessionActivated（后端单发给它的“你看这个”）。 */
function activationsOf(seen: any[]): any[] {
    return seen.filter((m) => m.type === "sessionActivated");
}

/** 这块屏收到的浮层（那个 <<< 面板 / 历史列表）。 */
function pickersOf(seen: any[]): any[] {
    return seen.filter((m) => m.type === "picker");
}

/** 后端让这块屏把浮层收起来（没人答超时、或者人在界面那头自己取消）。 */
function cancelsOf(seen: any[]): any[] {
    return seen.filter((m) => m.type === "pickerCancel");
}

/** 这块屏收到的“会话问你一句”那种框（确认 / 输入 / 选项）。 */
function dialogsOf(seen: any[]): any[] {
    return seen.filter((m) => m.type === "browserDialog");
}

/** 这块屏收到的“会话跑完一轮”。 */
function turnEndsOf(seen: any[]): any[] {
    return seen.filter((m) => m.type === "turnEnd");
}

/** 这块屏最后一次收到的会话列表。 */
function lastListOf(seen: any[]): any {
    const lists = seen.filter((m) => m.type === "sessionList");
    return lists.length > 0 ? lists[lists.length - 1] : undefined;
}

test("每块屏各看各的：一块屏新建会话，只有它自己被切走", () => {
    const work = tempDir("work");
    const { host, stop } = backend(work);
    try {
        const a = openScreen(host, "s-a", [work]);
        host.processPageMessage({ type: "ready" }, a.pageId);
        const firstId = host.getActive(a.pageId)?.id;
        assert.ok(firstId, "第一块屏该有一个会话可看");
        assert.equal(host.getActive(a.pageId)?.cwd, work);

        // 第二块屏连上（浏览器页面，没有工作区）：先看“最近有人看的那个”
        const b = openScreen(host, "s-b", []);
        host.processPageMessage({ type: "ready" }, b.pageId);
        assert.equal(host.getActive(b.pageId)?.id, firstId);

        // 第二块屏自己新建一个：它换过去了，第一块屏没被牵动
        const aBefore = activationsOf(a.seen).length;
        host.processPageMessage({ type: "newSession" }, b.pageId);
        const mine = host.getActive(b.pageId)?.id;
        assert.ok(mine && mine !== firstId);
        assert.equal(host.getActive(a.pageId)?.id, firstId, "第一块屏还看原来那个");
        assert.equal(activationsOf(b.seen).at(-1)?.sessionId, mine, "切走的消息只发给了动手的那块屏");
        assert.equal(activationsOf(a.seen).length, aBefore, "另一块屏没收到“切会话”这种消息");
        assert.equal(
            lastListOf(a.seen)?.sessions?.length, 2,
            "会话列表是共用的：另一块屏新建的会话它也看得到（只是它自己没切过去）",
        );
    } finally { stop(); }
});

test("VSCode 窗口连上：会话开在它打开的那个文件夹里，不是后端默认目录", () => {
    const workDefault = tempDir("default");
    const windowFolder = tempDir("project");
    const { host, stop } = backend(workDefault);
    try {
        const win = openScreen(host, "s-win", [windowFolder]);
        host.processPageMessage({ type: "ready" }, win.pageId);
        assert.equal(host.getActive(win.pageId)?.cwd, windowFolder);

        // 同一块屏再说一次 ready（网页视图重建）：会话不换
        const before = host.getActive(win.pageId)?.id;
        host.processPageMessage({ type: "ready" }, win.pageId);
        assert.equal(host.getActive(win.pageId)?.id, before);
        assert.equal(activationsOf(win.seen).at(-1)?.sessionId, before, "再说一次 ready 要告诉它看的是哪一个");
    } finally { stop(); }
});

test("那个目录里已经开着的会话：窗口连上就切过去，不另开一个", () => {
    const work = tempDir("shared");
    const { host, stop } = backend(tempDir("default"));
    try {
        // 手机那边（没有工作区概念的浏览器页面）先在 work 里开了一个会话并说了话
        const phone = openScreen(host, "s-phone", []);
        host.processPageMessage({ type: "newSessionInWorkspace", path: work }, phone.pageId);
        const existing = host.getActive(phone.pageId)?.id;
        assert.equal(host.getActive(phone.pageId)?.cwd, work);

        // VSCode 窗口打开着同一个目录：直接看那个已经开着的会话
        const win = openScreen(host, "s-win", [work]);
        host.processPageMessage({ type: "ready" }, win.pageId);
        assert.equal(host.getActive(win.pageId)?.id, existing);
        assert.equal((host as any).panels.size, 1, "没为它另开一个进程");
    } finally { stop(); }
});

test("关掉别的屏正在看的会话：动手的那块屏自己换走，看它的那块屏留在原地", () => {
    const work = tempDir("close");
    const { host, stop } = backend(work);
    try {
        const a = openScreen(host, "s-a", [work]);
        host.processPageMessage({ type: "ready" }, a.pageId);
        const watched = host.getActive(a.pageId)!.id;

        const b = openScreen(host, "s-b", []);
        host.processPageMessage({ type: "ready" }, b.pageId);
        assert.equal(host.getActive(b.pageId)?.id, watched, "第二块屏先看的是同一个会话");

        const activationsBefore = activationsOf(a.seen).length;
        host.processPageMessage({ type: "closeSession", sessionId: watched }, b.pageId);
        assert.equal((host as any).panels.has(watched), false, "会话真关掉了（进程停了）");
        // 动手的那块屏：后端给它换了一个（不然它没得看）
        const moved = activationsOf(b.seen).at(-1)?.sessionId;
        assert.ok(moved && moved !== watched, "动手关的那块屏自己被换到别的会话");
        // 看它的那块屏：没有“切到别的会话”的消息，界面上就停在原地
        assert.equal(activationsOf(a.seen).length, activationsBefore, "看它的那块屏不该被硬切走");
        assert.equal(
            lastListOf(a.seen)?.sessions?.some((s: any) => s.id === watched), false,
            "会话列表里已经没有那一个了",
        );
    } finally { stop(); }
});

test("两块屏各开各的浮层：一处点开、另一处那一个不被收掉", async () => {
    const work = tempDir("pickers");
    const { host, stop } = backend(work);
    try {
        const a = openScreen(host, "s-a", [work]);
        host.processPageMessage({ type: "ready" }, a.pageId);
        const b = openScreen(host, "s-b", []);
        host.processPageMessage({ type: "ready" }, b.pageId);

        // 两块屏各自点一次“项目与会话”（界面上那颗 <<<），两边都在等选择
        const aWaiting = host.showWorkspacePicker(a.pageId);
        await waitFor(() => pickersOf(a.seen).length > 0, 10000, "甲那边弹出面板");
        const bWaiting = host.showWorkspacePicker(b.pageId);
        await waitFor(() => pickersOf(b.seen).length > 0, 10000, "乙那边弹出面板");

        // 关键：谁开了都不影响另一块屏开着的那一个
        assert.deepEqual(cancelsOf(a.seen), [], "甲那边开着的面板没被乙顶掉");
        assert.deepEqual(cancelsOf(b.seen), [], "乙自己的也没被收掉");

        // 乙自己取消：乙那边收工，甲那边还等着（乙没把甲的等待一起了结）
        host.processPageMessage({ type: "pickerCancel", kind: "workspace" }, b.pageId);
        assert.equal(await bWaiting, undefined);
        let aDone = false;
        void aWaiting.then(() => { aDone = true; });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(aDone, false, "甲那边还开着（没被乙的取消带走）");

        // 甲自己取消：也收工
        host.processPageMessage({ type: "pickerCancel", kind: "workspace" }, a.pageId);
        assert.equal(await aWaiting, undefined);
        assert.deepEqual(cancelsOf(a.seen), [], "全程没人被后端收掉面板");
    } finally { stop(); }
});

test("会话问你的框：弹到正在看它的那块屏，不弹给别的屏", async () => {
    const work = tempDir("dialog");
    const { host, stop } = backend(work);
    try {
        const a = openScreen(host, "s-a", [work]);
        host.processPageMessage({ type: "ready" }, a.pageId);
        const b = openScreen(host, "s-b", []);
        host.processPageMessage({ type: "ready" }, b.pageId);
        // 乙自己另开一个：现在只有甲在看最初那个会话
        host.processPageMessage({ type: "newSession" }, b.pageId);
        const watched = host.getActive(a.pageId)!;

        const answer = host.confirmDialog("要跑这条命令吗？", "rm -rf /tmp/x", watched.id);
        await waitFor(() => dialogsOf(a.seen).length > 0 || dialogsOf(b.seen).length > 0, 10000, "框弹出来");
        assert.equal(dialogsOf(a.seen).length, 1, "弹给了正在看这个会话的那块屏（甲）");
        assert.equal(dialogsOf(b.seen).length, 0, "没弹给没在看它的那块屏（乙）");

        // 甲那边答“是”
        host.processPageMessage(
            { type: "browserDialogResult", id: dialogsOf(a.seen)[0].id, value: true },
            a.pageId,
        );
        assert.equal(await answer, true);
    } finally { stop(); }
});

test("会话跑完的声音：只在正看着它的那块屏上响", async () => {
    const work = tempDir("beep");
    const { host, stop } = backend(work);
    try {
        const a = openScreen(host, "s-a", [work]);
        host.processPageMessage({ type: "ready" }, a.pageId);
        const b = openScreen(host, "s-b", []);
        host.processPageMessage({ type: "ready" }, b.pageId);
        host.processPageMessage({ type: "newSession" }, b.pageId);
        const rt = host.getActive(a.pageId)!;

        host.onTurnEnd({ panelId: rt.id, status: "done", lastReplyText: "完事了" });
        await waitFor(() => turnEndsOf(a.seen).length > 0 && turnEndsOf(b.seen).length > 0, 10000, "两条屏都收到跑完的通知");
        assert.equal(turnEndsOf(a.seen).at(-1).beep, true, "在看它的那块屏要响");
        assert.equal(turnEndsOf(b.seen).at(-1).beep, false, "没在看它的那块屏不响（但“有新消息”照旧标）");
    } finally { stop(); }
});

test("往被关掉的会话里发消息：把它重新打开，再把这句话送过去", async () => {
    const work = tempDir("revive");
    const { host, stop } = backend(work);
    try {
        const a = openScreen(host, "s-a", [work]);
        host.processPageMessage({ type: "ready" }, a.pageId);
        const watched = host.getActive(a.pageId)!;
        // 等 pi 报告会话文件：重新打开它是靠这个路径
        await waitFor(() => !!watched.currentSessionPath, 30000, "会话文件报上来");
        const closedId = watched.id;

        const b = openScreen(host, "s-b", []);
        host.processPageMessage({ type: "ready" }, b.pageId);
        host.processPageMessage({ type: "closeSession", sessionId: closedId }, b.pageId);
        assert.equal((host as any).panels.has(closedId), false);

        // 还看着它的那块屏接着发话：后端把会话重开，并把这句话送进去
        host.processPageMessage({ type: "send", sessionId: closedId, text: "接着聊" }, a.pageId);
        const revived = await waitFor(() => {
            const rt = host.getActive(a.pageId);
            return rt && rt.id !== closedId && !rt.isConversationEmpty() ? rt : undefined;
        }, 60000, "关掉的会话被重新打开、话也送进去了");
        assert.equal(revived.cwd, work, "重开的会话还在原来那个目录里");
    } finally { stop(); }
});
