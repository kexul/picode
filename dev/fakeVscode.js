// @ts-nocheck
/**
 * fakeVscode —— 假的 vscode 模块（只在开发调试里用，不会打进插件）。
 *
 * 干什么：插件里只有一层皮（chatViewProvider.ts）会调用 VS Code 的接口，
 * 会话编排、会话进程、网页服务都不碰它。开发调试时把这一层皮换成这个文件，
 * 真插件代码就能在纯 Node 里跑起来，浏览器打开网页服务给的那个地址就是真界面。
 *
 * 两条原则：
 *   1. 用得到什么就实现什么，实现都写成"看得见、不拦路"的样子：
 *      弹窗打印一行日志就返回，读写配置走内存，编辑器相关的接口是空操作。
 *   2. 没实现的接口不崩：外面套一层 Proxy，取到什么就给一个空壳函数，
 *      只打印一行"未实现"（同一个名字只打一次）。这样插件新加了功能也不会把调试拦住。
 *
 * 换掉真接口会失真，所以下面这些在调试里是**验不到**的，需要时用 VSCodium 开发宿主看：
 *   diff 编辑器、符号跳转、剪贴板、状态栏、命令面板入口、侧边栏网页视图本身。
 */

const path = require("path");

/** 调试期间的可调项，由 dev/harness.js 在加载插件代码之前设好。 */
const state = {
    /** 会话的工作目录（pi 进程在哪里跑）。 */
    cwd: process.cwd(),
    /** 覆盖 piChat.* 配置项，例如 { piPath: "C:/x/pi.cmd", model: "sonnet" }。 */
    config: {},
    /** 界面颜色（显示选项里的那个）。 */
    theme: "light",
    /** 已加载完的界面选项（globalState 里的东西）。 */
    options: {},
    /** 写日志（默认打到标准输出）。 */
    log: (text) => console.log(text),
};

const saidOnce = new Set();
/** 同一句日志只说一次，免得反复调用把一个接口刷满屏。 */
function once(text) {
    if (saidOnce.has(text)) { return; }
    saidOnce.add(text);
    state.log(text);
}

/** 空壳：随便取什么属性、随便调用，都不报错。 */
function stub() {
    const target = function () { };
    return new Proxy(target, {
        get(_t, prop) {
            if (prop === "then" || typeof prop === "symbol") { return undefined; }
            if (prop === "dispose" || prop === "toString") { return () => undefined; }
            return stub();
        },
        apply() { return stub(); },
        construct() { return stub(); },
    });
}

const disposable = Object.freeze({ dispose() { } });
const subscribe = () => disposable;

/** 内存里的 globalState（显示选项存在这里）。 */
const store = {
    get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(state.options, key) ? state.options[key] : fallback;
    },
    update(key, value) {
        state.options[key] = value;
        return Promise.resolve();
    },
    keys() { return Object.keys(state.options); },
};

/** piChat.* 配置项：先看 state.config 里的覆盖值，再看插件传进来的默认值。 */
const configuration = {
    get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(state.config, key) ? state.config[key] : fallback;
    },
    has(key) { return Object.prototype.hasOwnProperty.call(state.config, key); },
    inspect() { return undefined; },
    update() { return Promise.resolve(); },
};

/** 打开的编辑器列表：调试里永远是空的（符号跳转、diff 这些验不到）。 */
let textDocuments = [];

const window = {
    // ---- 事件订阅：收下，永不触发 ----
    onDidChangeWindowState: subscribe,
    onDidChangeActiveTextEditor: subscribe,
    onDidChangeTextEditorSelection: subscribe,
    onDidChangeVisibleTextEditors: subscribe,
    onDidChangeTextEditorVisibleRanges: subscribe,
    onDidChangeTerminalState: subscribe,
    state: { focused: true, active: true },
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: { all: [], onDidChangeTabGroups: subscribe, onDidChangeTabs: subscribe },

    // ---- 弹窗：打印一行，返回"没选"（网页页面在的时候，插件会先问页面，走不到这里）----
    showInformationMessage: (message, ...rest) => {
        state.log(`[假 VSCode] 提示框：${firstLine(message)}`);
        return Promise.resolve(pickFromOptions(rest));
    },
    showWarningMessage: (message, ...rest) => {
        state.log(`[假 VSCode] 警告框：${firstLine(message)}`);
        return Promise.resolve(pickFromOptions(rest));
    },
    showErrorMessage: (message, ...rest) => {
        state.log(`[假 VSCode] 错误框：${firstLine(message)}`);
        return Promise.resolve(pickFromOptions(rest));
    },
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    showSaveDialog: () => Promise.resolve(undefined),
    showTextDocument: (uri) => {
        state.log(`[假 VSCode] 打开文件（调试里不弹编辑器）：${uri && uri.fsPath}`);
        return Promise.resolve(undefined);
    },
    withProgress: (_options, task) => task({ report() { } }, { isCancellationRequested: false, onCancellationRequested: subscribe }),
    createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }),
    createOutputChannel: () => ({ appendLine: (t) => state.log(t), show() { }, dispose() { } }),
    createTextEditorDecorationType: () => ({ dispose() { } }),
    registerWebviewViewProvider: () => disposable,
    registerTreeDataProvider: () => disposable,
    createTreeView: () => ({ dispose() { } }),
};

const workspace = {
    // ---- 工作区：调试时只有一个"打开的目录"，就是会话的工作目录 ----
    get workspaceFolders() {
        return [{ uri: Uri.file(state.cwd), name: path.basename(state.cwd), index: 0 }];
    },
    get textDocuments() { return textDocuments; },
    getConfiguration: () => configuration,
    onDidOpenTextDocument: subscribe,
    onDidCloseTextDocument: subscribe,
    onDidSaveTextDocument: subscribe,
    onDidChangeConfiguration: subscribe,
    onDidChangeTextDocument: subscribe,
    onDidChangeWorkspaceFolders: subscribe,
    onDidChangeVisibleTextEditors: subscribe,
    onDidRenameFiles: subscribe,
    onWillSaveTextDocument: subscribe,
    openTextDocument: (target) => {
        const fsPath = typeof target === "string" ? target : target && target.fsPath;
        let text = "";
        try { text = require("fs").readFileSync(fsPath, "utf8"); } catch { /* 读不到就当空文件 */ }
        return Promise.resolve({ uri: Uri.file(fsPath), fileName: fsPath, getText: () => text, version: 1 });
    },
    findFiles: () => Promise.resolve([]),
    asRelativePath: (p) => String(p),
    registerTextDocumentContentProvider: () => disposable,
    createFileSystemWatcher: () => ({ onDidChange: subscribe, onDidCreate: subscribe, onDidDelete: subscribe, dispose() { } }),
    fs: {
        readFile: (uri) => Promise.resolve(require("fs").readFileSync(uri.fsPath)),
        writeFile: (uri, data) => { require("fs").writeFileSync(uri.fsPath, data); return Promise.resolve(); },
        stat: (uri) => Promise.resolve(require("fs").statSync(uri.fsPath)),
        delete: () => Promise.resolve(),
    },
};

const commands = {
    registerCommand: () => disposable,
    registerTextEditorCommand: () => disposable,
    executeCommand: (name, ...args) => {
        // 符号树、diff、打开文件这些在调试里没有落地的地方，打印一行就当做过
        once(`[假 VSCode] 命令（调试里是空操作）：${name}`);
        return Promise.resolve(undefined);
    },
    getCommands: () => Promise.resolve([]),
};

class Uri {
    constructor(fsPath, scheme) {
        this.fsPath = String(fsPath);
        this.path = String(fsPath).replace(/\\/g, "/");
        this.scheme = scheme || "file";
    }
    static file(p) { return new Uri(p, "file"); }
    static parse(s) { return new Uri(String(s).replace(/^file:\/\//, ""), "file"); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts), base.scheme); }
    toString() { return `file:///${this.path.replace(/^\/+/, "")}`; }
}

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}

class Range {
    constructor(a, b, c, d) {
        if (typeof a === "number") {
            this.start = new Position(a, b);
            this.end = new Position(c ?? a, d ?? b);
        } else {
            this.start = a;
            this.end = b;
        }
    }
}

/** 从 showXxxMessage 的尾巴里挑一个返回值：有 {modal:true} 这种选项就跳过，取第一个字符串（"是"/"否" 这类按钮）。 */
function pickFromOptions(rest) {
    const pick = rest.find((item) => typeof item === "string");
    return pick;
}

/** 日志里只打第一行，长消息截断。 */
function firstLine(message) {
    const text = String(message ?? "").split("\n")[0];
    return text.length > 120 ? text.slice(0, 120) + "…" : text;
}

const explicit = {
    window,
    workspace,
    commands,
    Uri,
    Position,
    Range,
    Selection: class Selection { },
    Disposable: { from: () => disposable, dispose() { } },
    EventEmitter: class EventEmitter {
        constructor() { this.event = subscribe; }
        fire() { }
        dispose() { }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    env: {
        appRoot: "d:/fake-vscode",
        language: "zh-cn",
        uriScheme: "vscode",
        openExternal: () => Promise.resolve(true),
        clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve("") },
    },
    version: "1.85.0",
    extensions: { all: [], getExtension: () => undefined, onDidChange: subscribe },
    languages: {
        registerDocumentSymbolProvider: () => disposable,
        registerCodeLensProvider: () => disposable,
        match: () => [],
    },
};

/**
 * 整个模块套一层 Proxy：取到没实现的名字不要报错，给个空壳并记一行日志。
 * 特别注意 then：它必须返回 undefined，否则这个模块会被当成 Promise。
 */
const vscode = new Proxy(explicit, {
    get(target, prop) {
        if (prop === "then" || typeof prop === "symbol") { return undefined; }
        if (Object.prototype.hasOwnProperty.call(target, prop)) { return target[prop]; }
        const name = String(prop);
        once(`[假 VSCode] 用到了还没实现的接口：vscode.${name}（给的是空壳，调用不报错但没有效果）`);
        const created = stub();
        target[name] = created;
        return created;
    },
});

module.exports = vscode;
module.exports.__state = state;
module.exports.__store = store;
/** 调试脚手架在加载插件代码之前调用它，把工作目录、配置覆盖、界面颜色设进来。 */
module.exports.__configure = (patch) => { Object.assign(state, patch); };
/** 假装编辑器里打开着一个文件（符号跳转那类功能要用到）。 */
module.exports.__setOpenDocuments = (files) => { textDocuments = files; };
