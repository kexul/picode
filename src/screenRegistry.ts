import { dirInsideAny } from "./pathRules";

/**
 * ScreenRegistry —— 连上后端的"屏"（VS Code 窗口）登记簿。
 *
 * 为什么要有它：会话跑在独立后端里，但"用编辑器打开这个文件"只有 VS Code 干得了。
 * 于是每个开着插件的 VS Code 窗口都往后端登记一条连接（自称打开了哪些文件夹），
 * 页面里点文件时，后端按"这个会话在哪个目录"挑一个窗口去干。
 *
 * 挑法就一条规矩（用户定的）：**打开着这个目录的窗口才干活**；
 * 一个都没有就谁也不开（不随便找个窗口把文件开在错的工程里）。
 * 同一个目录开着好几个窗口时，挑最近有动静的那个（多半就是你正在用的那个）。
 *
 * 这里不碰网络：往连接里写、把连接关掉，都是网页服务传进来的函数（跟 PageChannels 一个思路）。
 */

/** 一条连上来的屏。 */
export interface Screen {
    id: string;
    /** 这个窗口打开着的文件夹（VS Code 的 workspace folders；空数组 = 空窗口，什么都不认）。 */
    folders: string[];
    /** 最近一次"人在这个窗口里动过"的时刻（窗口发来 active，或它的页面在发消息）。 */
    lastActiveAt: number;
    /** 最近一次收到这个窗口任何消息的时刻（判断死连接用）。 */
    lastSeenAt: number;
    /** 往后端回话（能力执行结果、符号集合）。 */
    send(msg: Record<string, unknown>): void;
}

export class ScreenRegistry {
    private readonly screens = new Map<string, Screen>();

    /** 登记一条屏连接（同一个 id 再来一次 = 它重连了，换掉旧的出口）。 */
    public add(id: string, folders: string[], send: (msg: Record<string, unknown>) => void): Screen {
        const existing = this.screens.get(id);
        const now = Date.now();
        const screen: Screen = {
            id,
            folders,
            // 重连时保留原来"最近有动静"的时刻：重连本身不代表人在窗口里动过
            lastActiveAt: existing?.lastActiveAt ?? now,
            lastSeenAt: now,
            send,
        };
        this.screens.set(id, screen);
        return screen;
    }

    /** 注销一条屏连接（窗口关了 / 连接断了）。 */
    public remove(id: string): void {
        this.screens.delete(id);
    }

    public get(id: string): Screen | undefined {
        return this.screens.get(id);
    }

    public list(): Screen[] {
        return Array.from(this.screens.values());
    }

    /** 这个窗口有人在动（切到前台、或它的页面在发消息）。 */
    public markActive(id: string): void {
        const screen = this.screens.get(id);
        if (screen) { screen.lastActiveAt = Date.now(); }
    }

    /** 收到这个窗口的任何消息（包括单纯的报活）。 */
    public markSeen(id: string): void {
        const screen = this.screens.get(id);
        if (screen) { screen.lastSeenAt = Date.now(); }
    }

    /** 半天没动静的连接（窗口崩了 / 网断了没通知到）。 */
    public staleIds(maxAgeMs: number): string[] {
        const now = Date.now();
        const out: string[] = [];
        for (const screen of this.screens.values()) {
            if (now - screen.lastSeenAt > maxAgeMs) { out.push(screen.id); }
        }
        return out;
    }

    /** 打开着这个目录的所有窗口。 */
    public matching(dir: string): Screen[] {
        return this.list().filter((s) => dirInsideAny(dir, s.folders));
    }

    /**
     * 该让谁来干这个目录上的活。
     * @returns 挑中的窗口；一个都没有时 undefined（调用方记一行日志，什么都不做）。
     */
    public pick(dir: string): Screen | undefined {
        const hits = this.matching(dir);
        if (hits.length === 0) { return undefined; }
        return hits.reduce((best, cur) => {
            if (cur.lastActiveAt !== best.lastActiveAt) {
                return cur.lastActiveAt > best.lastActiveAt ? cur : best;
            }
            // 同一时刻（刚连上来的都一样）：挑最后报活的那个，再看 id 图个稳定
            if (cur.lastSeenAt !== best.lastSeenAt) {
                return cur.lastSeenAt > best.lastSeenAt ? cur : best;
            }
            return cur.id < best.id ? cur : best;
        });
    }
}
