/**
 * 目标（/goal）：定一个「一直干到验收通过」的目标。
 *
 * 分两段做：
 *   第一段（这个文件已经在用的部分）—— /goal 定目标、先跟模型谈好验收清单、目标条显示、
 *   暂停 / 恢复 / 清除；
 *   第二段（还没做）—— 每轮跑完派一个判官子会话去验，没过就把批评发回来接着干。
 *
 * 全是纯函数：认命令、拼谈判提示、从模型回复里抽验收清单、算目标条上那一行字。
 * 存盘在 goalFiles.ts；拼提示词用到的原文在 promptText.ts（那边可被 config.json 覆盖）。
 */
import { promptText, type PromptOverrides } from "./promptText";

/** 目标处于哪一步。 */
export type GoalPhase =
    /** 正在谈验收条件：清单还没定下来（模型可能已经给了一版，用户在看着） */
    | "negotiating"
    /** 跑着：第二段那个循环靠它决定要不要继续催 */
    | "active"
    /** 用户让暂停：不自动往前推 */
    | "paused"
    /** 验收通过了 */
    | "complete";

export interface GoalState {
    /** 用户要干的那件事（User typed 的那一段，原样留着）。 */
    objective: string;
    /** 验收清单：一条一条能验证的。谈定之前是空数组。 */
    criteria: string[];
    phase: GoalPhase;
    /** 目标定下来的时刻（ms）；还在谈的时候是 0。 */
    startedAt: number;
    /** 这是第几轮（第二段用；第一段一直是 0）。 */
    rounds: number;
    /** 最近一次的一句话交代：判官说了什么、或者为什么停了（目标条展开时给人看）。 */
    note?: string;
    /** 最近一次改动的时刻（写盘、比对用）。 */
    updatedAt: number;
}

/** 用户打的目标命令，也是目标条上那几颗按钮按下时用的（见 chatControllerBase.onGoalCommand）。 */
export type GoalCommand =
    | { kind: "set"; objective: string }
    | { kind: "start" }
    | { kind: "show" }
    | { kind: "pause" }
    | { kind: "resume" }
    | { kind: "clear" };

/** 验收清单在模型回复里的记号（谈判提示里要求它用这个开头，这里照着取）。 */
export const GOAL_CRITERIA_MARK = "[验收清单]";

/** 清单最多认多少条（模型列了一百条也不算数，取前面这些）。 */
const MAX_CRITERIA = 12;

/**
 * 这一句是不是 /goal 命令：只有定目标（`/goal <要干成什么>`）与看状态（`/goal`）两种。
 *
 * 开始 / 暂停 / 继续 / 停止 不在命令行里：它们是目标条点开以后那几颗按钮（见 GoalCommand）。
 * 打的要是那些词，由 isGoalControlWord 拦住，别稀里糊涂定成一个叫「停止」的目标。
 */
export function parseGoalCommand(text: string): GoalCommand | null {
    if (typeof text !== "string") { return null; }
    const m = text.match(/^\/goal(?:[ \t]+([\s\S]*))?$/i);
    if (!m) { return null; }
    const rest = (m[1] ?? "").trim();
    if (!rest) { return { kind: "show" }; }
    return { kind: "set", objective: rest };
}

/** 以前用命令管的那些词（现在都是目标条上的按钮）；打这些词是误操作，不当成新目标。 */
const CONTROL_WORDS = [
    "开始", "开跑", "continue", "start",
    "暂停", "停下", "pause",
    "继续", "恢复", "resume",
    "清除", "取消", "关闭", "关掉", "停止", "结束", "退出",
    "clear", "stop", "close", "end",
];

/** 打进来的是不是「以前那个控制词」（是就别拿它当目标原文）。 */
export function isGoalControlWord(text: string): boolean {
    const t = text.trim().toLowerCase();
    return !!t && CONTROL_WORDS.indexOf(t) >= 0;
}

/**
 * 谈判提示：把目标发下去，要模型先只列验收清单、别动手。
 *
 * 用户打的那一行原文放在开头：记录里、还有「你说过的话」里都能看见是他自己说的那句话，
 * 但整条只有这一条消息 —— 分开成两条的话，模型会先把原文当任务干起来，再看到「先别动手」。
 */
export function buildGoalNegotiationPrompt(p: { objective: string }, over?: PromptOverrides): string {
    return promptText(over, "goalNegotiate", {
        原文首行: p.objective.split("\n")[0].slice(0, 200),
        目标: p.objective.trim(),
    });
}

/**
 * 从模型回复里取验收清单。
 * 有 [验收清单] 记号就只认它后面那一段；没有就认全文里的短横线 / 编号条目（模型没照格式写时的兜底）。
 */
export function parseGoalCriteria(reply: string): string[] {
    const lines = (reply || "").split(/\r?\n/);
    const markAt = lines.findIndex((l) => l.includes(GOAL_CRITERIA_MARK));
    const out: string[] = [];
    if (markAt >= 0) {
        for (const raw of lines.slice(markAt + 1)) {
            const line = raw.trim();
            const item = bulletText(line);
            if (item) { out.push(item); continue; }
            // 清单到这儿结束了：遇到空行之后又有正文，就收工
            if (out.length > 0) { break; }
        }
    } else {
        for (const raw of lines) {
            const item = bulletText(raw.trim());
            if (item) { out.push(item); }
        }
    }
    return out.slice(0, MAX_CRITERIA);
}

/** 一行是不是清单条目（`- xxx` / `* xxx` / `1. xxx` / `1、xxx`）；是就返回条目正文。 */
function bulletText(line: string): string | undefined {
    if (!line) { return undefined; }
    const m = line.match(/^(?:[-*•·]|\d+[.)、])\s*(.+)$/);
    if (!m) { return undefined; }
    const t = m[1].trim();
    return t || undefined;
}

/** 开跑提示：清单定了，让模型现在动手，一直干到清单全过。 */
export function buildGoalStartPrompt(goal: GoalState, over?: PromptOverrides): string {
    return promptText(over, "goalStart", {
        目标: goal.objective.trim(),
        验收清单: goal.criteria.map((c) => "- " + c).join("\n"),
    });
}

/** 恢复时补的一句：目标接着算，别从头再来。 */
export function buildGoalResumePrompt(goal: GoalState, over?: PromptOverrides): string {
    return promptText(over, "goalResume", {
        目标: goal.objective.trim(),
        验收清单: goal.criteria.map((c) => "- " + c).join("\n"),
    });
}

/** 目标条上那一行字（纯函数；界面直接显示它）。 */
export interface GoalBarSummary {
    /** 一行摘要。 */
    text: string;
    /** 颜色 / 呼吸那套：谈条件 / 跑着 / 停了 / 完成。 */
    tone: "talk" | "run" | "stop" | "done";
}

/**
 * @param judging 这一轮正有判官在验（工人自己已经跑完了）：要写出来，
 *   不然界面看着像卡住了 —— 判官那边一般要几分钟。
 */
export function goalBarSummary(goal?: GoalState | null, judging = false): GoalBarSummary | undefined {
    if (!goal) { return undefined; }
    switch (goal.phase) {
        case "negotiating":
            return {
                text: goal.criteria.length > 0
                    ? `目标待确认 · 验收 ${goal.criteria.length} 条`
                    : "目标待确认 · 还在谈验收条件",
                tone: "talk",
            };
        case "active":
            return {
                text: "目标进行中"
                    + (goal.rounds > 0 ? ` · 第 ${goal.rounds} 轮` : "")
                    + (judging ? " · 判官正在验" : ""),
                tone: "run",
            };
        case "paused":
            return { text: "目标已暂停", tone: "stop" };
        case "complete":
            return { text: "目标已完成", tone: "done" };
        default:
            return undefined;
    }
}
