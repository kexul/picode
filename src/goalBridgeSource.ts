/**
 * 目标（/goal）第二段：判官会话里那个 `update_goal` 工具（塞进 pi 进程的扩展）。
 *
 * 插件把这份源码写到 ~/.pi/pichat/goal-bridge-<插件版本>.ts，
 * **只有判官会话**启动时会用 `-e` 加载它（普通会话不给这个工具：那个工具只能由判官用，
 * 工人自己说"我做完了"不算数，这正是分开判的意义）。
 *
 * 工具被调用时只往本进程的 stderr 写一行暗号（见 goalProtocol.ts），插件读到就知道判官的结论。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留。
 */
import { GOAL_FRAME_PREFIX } from "./goalProtocol";

export const GOAL_BRIDGE_SOURCE = String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：给「判官」会话一个工具 update_goal —— 它验完工人这一轮的活，用这个工具报结论。
 * 插件读本进程的 stderr，读到暗号就去改目标状态、决定还要不要催工人接着干。
 *
 * 注意：判官会话是用 --tools 白名单起的，pi 会把扩展注册的工具也过一遍名单 ——
 * 所以 update_goal 这个名字必须列进那个白名单（见 chatControllerBase 的 GOAL_JUDGE_TOOLS），
 * 漏了的话判官照样能把活验完，就是报不上来，插件那边看到的是"判官没给出结论"。
 */
const FRAME_PREFIX = ${JSON.stringify(GOAL_FRAME_PREFIX)};

function emit(payload) {
    try {
        process.stderr.write(FRAME_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
    } catch {
        // 写不出去就算了：插件那边表现为"没等到结论"，会按没结论那条路处理
    }
}

function text(v, limit) {
    if (typeof v !== "string") { return ""; }
    const t = v.trim();
    if (!t) { return ""; }
    return t.length > limit ? t.slice(0, limit) : t;
}

const PARAMS = {
    type: "object",
    properties: {
        pass: {
            type: "boolean",
            description: "验收清单是不是全部通过了。只有每一条都拿得出证据（跑过的命令、看到的结果）才许写 true。",
        },
        summary: {
            type: "string",
            description: "一句话结论：过了就写过了什么证据，没过就写卡在哪。",
        },
        missing: {
            type: "array",
            items: { type: "string" },
            description: "没过的验收条目：照抄目标里那几条原文，一条一项。pass 为 true 时留空。",
        },
        next: {
            type: "string",
            description: "让工人接着干什么：具体到能照着改（哪个文件、哪条命令、期望看到什么）。pass 为 true 时留空。",
        },
    },
    required: ["pass", "summary"],
    additionalProperties: false,
};

const DESCRIPTION =
    "报出这次验收的结论。你（判官）验完工人这一轮的活以后必须调用它，只能调一次。" +
    "pass=true 表示验收清单每一条都过了（要有证据）；否则 pass=false，在 missing 里写清哪几条没过、" +
    "在 next 里写清让工人接着改什么。结论会交回插件，插件据它决定是让工人继续干还是收工。";

export default function goalBridge(pi) {
    try {
        pi.registerTool({
            name: "update_goal",
            label: "报验收结论",
            description: DESCRIPTION,
            parameters: PARAMS,
            async execute(_toolCallId, params) {
                const summary = text(params && params.summary, 2000);
                if (typeof (params && params.pass) !== "boolean" || !summary) {
                    return {
                        content: [{ type: "text", text: "报不上去：pass（true/false）和 summary 都要给。" }],
                        details: { error: "missing pass or summary" },
                    };
                }
                const missing = Array.isArray(params.missing)
                    ? params.missing.map((x) => text(x, 500)).filter((x) => x)
                    : [];
                const next = text(params.next, 4000);
                emit({ kind: "verdict", pass: params.pass, summary, missing, next });
                const tail = params.pass
                    ? "结论已经交回插件：这个目标算验收通过。你可以停在这儿了。"
                    : "结论已经交回插件：工人会收到这份意见接着干，你不用再催。";
                return {
                    content: [{ type: "text", text: "报上去了。" + tail }],
                    details: { pass: params.pass, missing: missing.length },
                };
            },
        });
    } catch (e) {
        // 名字被占了之类：不让整个 pi 起不来（插件那边表现为"没等到结论"）
        try {
            process.stderr.write("[goal-bridge] 注册 update_goal 失败：" + String((e && e.message) || e) + "\n");
        } catch { /* 写不出去也没辙 */ }
    }
}
`;
