/**
 * 独立后端的宿主：把一份会话工作区挂在一个纯 Node 进程上（没有 VSCode）。
 *
 * 跟平台有关的那几件事在这里填：
 *   - 设置从 `~/.pi/pichat/config.json` 读（人改的），显示选项存 `state.json`（界面改的）；
 *   - 默认工作目录就是起后端时指定的目录（--cwd，默认你敲命令时所在的目录）；
 *   - 弹窗只有页面可问（问不着就按"否 / 取消"，宁可不动也不乱来）；
 *   - 会话跑完照样弹 Windows 系统通知（走 turnToast，不依赖 VSCode）；
 *   - 编辑器才有的那些（点开文件、符号跳转）派给连上来的 VS Code 窗口（见基类的 routeToScreen）。
 *
 * 页面连接的登记、断线补发、浮层该弹哪块屏、活该派给哪个窗口这些跟 VSCode 无关的事
 * 都在 {@link ChatHostBase}。
 */
import { ChatHostBase } from "./chatHostBase";
import { ServerStateStore } from "./serverState";
import { readServerConfig, updateServerConfig, type ServerConfig } from "./serverConfig";
import { getTabaAssets } from "./tabaAssets";
import { TurnToast } from "./turnToast";
import { serverConfigFile, serverStateFile } from "./serverPaths";
import type { TurnEndInfo } from "./runtimeTypes";

export interface ServerChatHostOptions {
    /** 默认工作目录（会话默认跑在这里）。 */
    cwd: string;
    /** 本后端的版本号（写地址文件、登记通知标识用）。 */
    version: string;
    /** 通知的应用标识（登记中，是个承诺）。 */
    toastAppId?: string | Promise<string>;
    /** 日志出口（默认打标准输出）。 */
    log?: (text: string) => void;
    /** 设置与状态文件的目录（测试里换掉；默认 ~/.pi/pichat）。 */
    dir?: string;
}

export class ServerChatHost extends ChatHostBase {
    private readonly state: ServerStateStore;
    private readonly log: (text: string) => void;
    private readonly dir?: string;
    private toast?: TurnToast;
    private disposed = false;

    constructor(private readonly options: ServerChatHostOptions) {
        super("server");
        this.log = options.log ?? ((text) => console.log(text));
        this.dir = options.dir;
        this.state = new ServerStateStore(serverStateFile(options.dir));
    }

    // ---- 显示选项的存储：state.json（界面改的），读的时候先看它，再看配置文件里预设的 ----
    protected readOption<T>(key: string, fallback: T): T {
        // 这里取原始值，不传 fallback 给底层做类型校验：类型不对要“回落到配置文件预设”，
        // 而底层只会在类型不符时还给 fallback。取值合不合法由各自的读取器（inList / 正则）盯。
        const stored = this.state.all()[key];
        if (stored !== undefined) { return stored as T; }
        // 配置文件里也能预设一份（人不进界面就能改默认值）；两项都没有才用内置默认值。
        const preset = this.configPreset(key);
        return (preset === undefined ? fallback : preset) as T;
    }

    protected writeOption(key: string, value: unknown): void {
        this.state.update(key, value);
    }

    /** 显示选项在配置文件里的对应项。 */
    private configPreset(key: string): unknown {
        const cfg: ServerConfig = readServerConfig(this.dir).config;
        switch (key) {
            case ServerChatHost.KEY_THEME: return cfg.themeMode;
            case ServerChatHost.KEY_FONT_SIZE: return cfg.fontSize;
            case ServerChatHost.KEY_SEND_KEY: return cfg.sendKey;
            case ServerChatHost.KEY_NEW_SESSION_KEY: return cfg.newSessionKey;
            case ServerChatHost.KEY_TAB_SWITCH_KEY: return cfg.tabSwitchKey;
            case ServerChatHost.KEY_FOCUS_INPUT_KEY: return cfg.focusInputKey;
            case ServerChatHost.KEY_NOTIFY_BEEP: return cfg.notifyBeep;
            case ServerChatHost.KEY_AUTO_LOAD_LAST: return cfg.autoLoadLast;
            case ServerChatHost.KEY_TURN_TITLE_WAIT: return cfg.turnTitleWaitSeconds;
            default: return undefined;
        }
    }

    protected override onNotice(text: string): void {
        this.log(`[提示] ${text}`);
    }

    /**
     * 问不着页面时的兜底：随便挑一块连着的屏。
     * 手机上刚打开页面、还没做过任何动作时，也需要有人来答"要不要执行这条命令"。
     */
    protected override pageForDialogFallback(): string | undefined {
        return this.getBroadcaster().recentPage()?.id;
    }

    // ---- RuntimeHost：配置 / cwd ----
    public getConfig() {
        const cfg = readServerConfig(this.dir).config;
        const taba = cfg.tabaEnabled ? getTabaAssets() : undefined;
        return {
            piPath: cfg.piPath,
            provider: cfg.provider,
            model: cfg.model,
            extraArgs: cfg.extraArgs,
            trustProject: cfg.trustProject,
            tabaExtension: taba?.ok ? taba.extensionPath : "",
            tabaDir: taba?.ok ? taba.resourceDir : "",
        };
    }

    public getCwd(): string {
        return this.options.cwd;
    }

    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，`
            + `或改 ${serverConfigFile(this.dir)} 里的 piPath。`;
    }

    protected onPiMissing(piPath: string): void {
        this.log(`[错误] ${this.piMissingMessage(piPath)}`);
    }

    public persistModel(provider: string, modelId: string): void {
        updateServerConfig({ provider, model: modelId }, this.dir);
    }

    // ---- 编辑器才有的那几样：基类已经派给打开着这个工作区的 VS Code 窗口，这里不用再写 ----

    /** 平台独有的消息：正文里的符号链接（只有编辑器有语言服务，派给窗口去它读写过的文件里找）。 */
    protected handleHostMessage(msg: any): boolean {
        if (msg?.type === "openSymbol") {
            if (typeof msg.name === "string") {
                this.routeToScreen("openSymbol", {
                    name: msg.name,
                    knownFiles: this.getAllKnownFiles(),
                }, `找符号 ${msg.name}`);
            }
            return true;
        }
        return false;
    }

    // ---- 会话跑完的系统通知 ----
    protected override notifyTurnEnd(info: TurnEndInfo): void {
        if (!this.toast) {
            this.toast = new TurnToast({
                appUserModelId: this.options.toastAppId,
                onBatchFailed: (_batch, reason) => {
                    // 通知发不出去时至少留一行日志：不然"会话跑完了没动静"没人查得出来。
                    this.log(`[提醒] Windows 系统通知没发出去：${reason}`);
                },
            });
        }
        this.toast.handleTurnEnd(info);
    }

    /** 收摊：停掉所有 pi 进程、收掉通知中心（网页服务的收摊由启动器负责）。 */
    public dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.toast?.dispose();
        this.toast = undefined;
        this.disposeAllConversations();
    }
}
