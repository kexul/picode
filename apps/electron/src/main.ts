import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import * as path from "path";
import { AppConfig, loadConfig, saveConfig, touchProject } from "./config";
import { ChatController, initSharedRoot } from "./chatController";
import { openFileViewer } from "./fileViewer";
import { readModelsJson, writeModelsJson, defaultModelsJson } from "../../../src/shared/modelsConfig";

let mainWindow: BrowserWindow | null = null;
let cfg: AppConfig;
let controller: ChatController;

function post(msg: Record<string, unknown>): void {
    mainWindow?.webContents.send("ph", msg);
}

function sendProjects(): void {
    post({ type: "app:projects", projects: cfg.recentProjects.map((p) => ({ path: p, name: path.basename(p) })) });
}

function setProject(dir: string): void {
    controller.setProject(dir);
    touchProject(cfg, dir);
    post({ type: "app:currentProject", path: dir, name: path.basename(dir) });
    sendProjects();
    mainWindow?.setTitle(`Pi Chat — ${path.basename(dir)}`);
}

async function pickProjectDialog(): Promise<void> {
    const result = await dialog.showOpenDialog(mainWindow!, {
        title: "选择项目文件夹",
        properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    setProject(result.filePaths[0]);
}

function routeMessage(msg: any): void {
    switch (msg.type) {
        case "app:ready":
            sendProjects();
            if (cfg.recentProjects.length > 0) setProject(cfg.recentProjects[0]);
            else post({ type: "app:requestPickProject" });
            break;
        case "app:pickProject": void pickProjectDialog(); break;
        case "app:switchProject": if (typeof msg.path === "string") setProject(msg.path); break;
        case "app:requestProjects": sendProjects(); break;
        case "app:requestViewOptions": controller.pushViewOptions(); break;
        case "app:toggleViewOption":
            if (msg.key === "showStatsBar" || msg.key === "autoLoadLastSession") controller.toggleViewOption(msg.key);
            break;
        case "app:cycleSendKey": controller.cycleSendKey(); break;
        case "app:requestHistory": void controller.showHistory(); break;
        case "app:openViewOptions": controller.showViewOptionsPicker(); break;
        case "app:openHistory": if (typeof msg.file === "string") void controller.loadHistorySession(msg.file); break;
        case "app:requestSettings": post({ type: "app:settings", ...readModelsJson() }); break;
        case "app:saveSettings": post({ type: "app:settingsResult", ...writeModelsJson(msg.content) }); break;
        case "app:getDefaultModels": post({ type: "app:defaultModels", content: defaultModelsJson() }); break;
        default: controller.onMsg(msg);
    }
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1180, height: 800, minWidth: 720, minHeight: 480,
        title: "Pi Chat", backgroundColor: "#ffffff",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: false, nodeIntegration: false, sandbox: false,
        },
    });
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    mainWindow.on("closed", () => { controller.dispose(); mainWindow = null; });
}

app.whenReady().then(() => {
    cfg = loadConfig();
    initSharedRoot(path.join(__dirname, "..", "renderer"));
    Menu.setApplicationMenu(null);
    createWindow();
    controller = new ChatController({
        post,
        getConfig: () => cfg,
        saveConfig: () => saveConfig(cfg),
        openFileViewer: (p, line, anchor) => openFileViewer(mainWindow, p, line, anchor),
        onSessionChanged: (sessionPath) => post({ type: "app:currentSession", sessionPath }),
    });
    ipcMain.on("pc", (_e, msg) => routeMessage(msg));
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
