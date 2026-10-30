/**
 * 目标（/goal）第二段：判官这一轮要说什么、判官没过时发回给工人的是什么。
 *
 * 判官一上来先看两件事：工人这一轮自己有没有说没做完。说了就直接报「继续」（pass=false），
 * 不再下场一条条验 —— 它自己都承认没做完，验了也白验，下一轮还得重来。
 * 没说才按验收清单一条条核。
 *
 * 为什么判官另起一个会话来当，而不是让工人自己说"我做完了"：模型给自己的活打分一律往好里打
 * （Anthropic 那篇长跑 harness 的文章里把这条列成最需要单独解决的一件事）。
 * 分开以后要调教的是判官一个人，比让工人自己变刻薄容易得多。
 *
 * 全是纯函数，不碰文件、不碰 vscode。
 */
import type { GoalState } from "./goal";
import type { GoalVerdictRequest } from "./goalProtocol";
import { promptText, type PromptOverrides } from "./promptText";

/** 判官的现场材料：工人这一轮说了什么、工人会话文件在哪。 */
export interface GoalJudgeInput {
    goal: GoalState;
    /** 第几轮（从 1 数）。 */
    round: number;
    /** 工人这一轮最后一条回复（它的交代）。 */
    workerReport: string;
    /** 工人的 .jsonl 路径：判官想看全过程自己读（空串表示还拿不到）。 */
    workerSessionFile: string;
    /** 工人会话的工作目录（判官在同一个目录里跑验证命令）。 */
    cwd: string;
}

/** 判官那一轮的任务说明（原文见 promptText.ts 的 goalJudge，人可以改）。 */
export function buildGoalJudgePrompt(p: GoalJudgeInput, over?: PromptOverrides): string {
    // 那一段文件说明带着结尾空行：有文件才有这一段，没文件连空行一起不留
    const fileSection = p.workerSessionFile
        ? [
            "【工人的会话文件】" + p.workerSessionFile,
            "真要往下验的时候才去读（只报「继续」的那一轮不用读）：一行一条记录，它说的话、"
            + "每次工具调用与返回都在里面。文件可能很大，别一次整个读进来"
            + "（用 read 的 offset / limit，或者 bash 的 tail / grep 挑重点）。",
            "",
            "",
        ].join("\n")
        : "";
    return promptText(over, "goalJudge", {
        轮次: String(p.round),
        目标: p.goal.objective.trim(),
        验收清单: p.goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
        工人交代: (p.workerReport || "").trim() || "（这一轮它没留下回复）",
        工人会话文件段: fileSection,
        目录: p.cwd,
    });
}

/** 判官没过时，发回给工人的那段话（工人看到这个就会接着干下一轮）。 */
export function buildGoalFeedbackPrompt(p: {
    round: number;
    judge: GoalVerdictRequest;
    /** 判官会话还在不在（在的话告诉工人可以直接去问它）。 */
    judgeSessionName?: string;
}, over?: PromptOverrides): string {
    const verdict = p.judge;
    // 这一小段带着结尾空行：有没过的条目才有它，没有就连空行一起不留
    const missing = verdict.missing.length
        ? ["【没过的条目】", ...verdict.missing.map((m) => "- " + m), "", ""].join("\n")
        : "";
    return promptText(over, "goalFeedback", {
        轮次: String(p.round),
        结论: verdict.summary,
        没过的条目: missing,
        接着改什么: verdict.next || "按上面的结论把没过的地方改到能验过为止。",
    });
}
