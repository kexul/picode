import { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import * as path from "path";
import * as url from "url";

const openWindows = new Map<string, BrowserWindow>();

export function openFileViewer(
    parent: BrowserWindow | null,
    filePath: string,
    line: number,
    anchor?: string
): void {
    const existing = openWindows.get(filePath);
    if (existing && !existing.isDestroyed()) {
        existing.webContents.send("fv:goto", { line, anchor });
        existing.focus();
        return;
    }

    const opts: BrowserWindowConstructorOptions = {
        width: 1000,
        height: 720,
        title: path.basename(filePath),
        backgroundColor: "#ffffff",
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    };
    if (parent) opts.parent = parent;

    const win = new BrowserWindow(opts);
    openWindows.set(filePath, win);
    win.on("closed", () => openWindows.delete(filePath));

    const vUrl = url.pathToFileURL(path.join(__dirname, "..", "renderer", "viewer.html"));
    vUrl.searchParams.set("path", filePath);
    vUrl.searchParams.set("line", String(line));
    if (anchor) vUrl.searchParams.set("anchor", anchor);
    win.loadURL(vUrl.href);
}
