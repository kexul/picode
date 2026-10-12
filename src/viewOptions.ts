/**
 * 显示选项的候选取值与默认值（界面颜色、字号、几个快捷键、提醒开关这些）。
 *
 * 单独放一个文件：两份宿主（插件、独立后端）都要用同一套候选与默认值，
 * 存储各自不同（VSCode 存 globalState，独立后端存 state.json）。这里只放取值，
 * 不碰存储、不引用 vscode，可以单测。
 */

export const SEND_KEYS = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;
export const NEW_SESSION_KEYS = ["ctrl+alt+n", "ctrl+shift+n", "ctrl+t", "alt+n"] as const;
export const TAB_SWITCH_KEYS = ["ctrl+alt+arrows", "ctrl+alt+pgupdown", "alt+brackets", "ctrl+alt+brackets"] as const;
export const FOCUS_INPUT_KEYS = ["ctrlAltI", "ctrlShiftI", "altI", "ctrlAltSpace"] as const;

export const DEFAULT_SEND_KEY = "enter";
export const DEFAULT_NEW_SESSION_KEY = "ctrl+alt+n";
export const DEFAULT_TAB_SWITCH_KEY = "ctrl+alt+arrows";
export const DEFAULT_FOCUS_INPUT_KEY = "ctrlAltI";
export const DEFAULT_FONT_SIZE = "14";
export const DEFAULT_THEME_MODE: "light" | "dark" = "light";
export const DEFAULT_NOTIFY_BEEP = true;
export const DEFAULT_AUTO_LOAD_LAST = false;

/** 取候选列表里的下一个值（用在“点一下换下一个”的按钮上）；当前值不在列表里就从第一个开始。 */
export function nextInList(list: readonly string[], current: string): string {
    const at = list.indexOf(current);
    return list[(at + 1) % list.length];
}

/** 候选列表里有没有这个值；用于读存储时校验（存坏了就回默认值）。 */
export function inList(list: readonly string[], value: unknown): value is string {
    return typeof value === "string" && list.includes(value);
}
