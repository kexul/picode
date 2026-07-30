import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** 客户端配置目录（与 pi 的 ~/.pi/agent 同根，独立子目录）。 */
function configDir(): string {
    return path.join(os.homedir(), ".pi", "chat-client");
}

function configPath(): string {
    return path.join(configDir(), "config.json");
}

export interface ViewOptions {
    showStatsBar: boolean;
    autoLoadLastSession: boolean;
    sendKey: string;
    newSessionKey: string;
    tabSwitchKey: string;
    notifyOnTurnEnd: boolean;
}

export interface AppConfig {
    piPath: string;
    provider: string;
    model: string;
    extraArgs: string[];
    trustProject: boolean;
    recentProjects: string[];
    view: ViewOptions;
}

export const DEFAULT_CONFIG: AppConfig = {
    piPath: "pi",
    provider: "",
    model: "",
    extraArgs: [],
    trustProject: true,
    recentProjects: [],
    view: { showStatsBar: true, autoLoadLastSession: false, sendKey: "enter", newSessionKey: "ctrl+alt+n", tabSwitchKey: "ctrl+alt+arrows", notifyOnTurnEnd: true },
};

export function loadConfig(): AppConfig {
    try {
        const raw = fs.readFileSync(configPath(), "utf8");
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_CONFIG,
            ...parsed,
            view: { ...DEFAULT_CONFIG.view, ...(parsed.view || {}) },
        };
    } catch {
        return { ...DEFAULT_CONFIG, view: { ...DEFAULT_CONFIG.view } };
    }
}

export function saveConfig(cfg: AppConfig): void {
    try {
        fs.mkdirSync(configDir(), { recursive: true });
        fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
    } catch (e) {
        console.error("[config] 保存失败:", e);
    }
}

export function touchProject(cfg: AppConfig, projectDir: string): void {
    const norm = path.resolve(projectDir);
    cfg.recentProjects = [norm, ...cfg.recentProjects.filter((p) => p !== norm)].slice(0, 20);
    saveConfig(cfg);
}
