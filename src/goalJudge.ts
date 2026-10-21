/**
 * 目标（/goal）第二段：判官这一轮要说什么、判官没过时发回给工人的是什么。
 *
 * 为什么判官另起一个会话来当，而不是让工人自己说"我做完了"：模型给自己的活打分一律往好里打
 * （Anthropic 那篇长跑 harness 的文章里把这条列成最需要单独解决的一件事）。
 * 分开以后要调教的是判官一个人，比让工人自己变刻薄容易得多。
 *
 * 全是纯函数，不碰文件、不碰 vscode。
 */
import type { GoalState } from "./goal";
import type { GoalVerdictRequest } from "./goalProtocol";

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

/** 判官那一轮的任务说明。 */
export function buildGoalJudgePrompt(p: GoalJudgeInput): string {
    const report = (p.workerReport || "").trim();
    const lines = [
        `【验收第 ${p.round} 轮】你是判官：验工人这一轮的活，别自己动手改。`,
        "",
        "【目标】",
        p.goal.objective.trim(),
        "",
        "【验收清单】（每条都要有证据才算过）",
        ...p.goal.criteria.map((c, i) => `${i + 1}. ${c}`),
        "",
        "【工人这一轮的交代】",
        report || "（这一轮它没留下回复）",
    ];
    if (p.workerSessionFile) {
        lines.push(
            "",
            "【工人的会话文件】" + p.workerSessionFile,
            "想核它到底干了什么，就自己读这个文件：一行一条记录，它说的话、每次工具调用与返回都在里面。"
            + "文件可能很大，别一次整个读进来（用 read 的 offset / limit，或者 bash 的 tail / grep 挑重点）。",
        );
    }
    lines.push(
        "",
        "【怎么验】",
        "- 逐条核清单：能跑就跑（测试、命令、脚本），能读就读（文件、日志、输出），不要只听工人说。",
        "- 你在这个工人的目录里跑：" + p.cwd,
        "- 只验不改：不许改任何文件、不许装东西、不许提交代码。只做只读的检查和跑测试。",
        "- 有一条拿不出证据就不算过。别通融：这一轮放过的问题，后面没人会再发现。",
        "",
        "【怎么交结论】验完必须调用工具 update_goal（只调一次）：",
        "- pass：每一条都过了才写 true；",
        "- summary：一句话说清过了什么、或者卡在哪；",
        "- missing：没过的条目照抄上面清单的原文，一条一项；",
        "- next：要工人接着干什么，具体到哪个文件、哪条命令、期望看到什么。",
    );
    return lines.join("\n");
}

/** 判官没过时，发回给工人的那段话（工人看到这个就会接着干下一轮）。 */
export function buildGoalFeedbackPrompt(p: {
    round: number;
    judge: GoalVerdictRequest;
    /** 判官会话还在不在（在的话告诉工人可以直接去问它）。 */
    judgeSessionName?: string;
}): string {
    const verdict = p.judge;
    const missing = verdict.missing.length
        ? ["【没过的条目】", ...verdict.missing.map((m) => "- " + m)]
        : [];
    return [
        `【验收第 ${p.round} 轮没过】判官验完你这一轮了，接着干。`,
        "",
        "【判官的一句话结论】",
        verdict.summary,
        ...missing,
        "",
        "【接着改什么】",
        verdict.next || "按上面的结论把没过的地方改到能验过为止。",
        "",
        "【规矩】",
        "- 目标不达成不要停：改完自己再验一遍，然后再等判官验收。",
        "- 别为了凑验收去改验收清单本身（清单只有用户能改）。",
        "- 已经在过的条目不用重做，只处理没过的。",
    ].join("\n");
}
