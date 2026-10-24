/**
 * 派子会话（taba）：把"派活请求"算成"子会话该怎么起"。
 *
 * 只算，不碰文件、不碰 vscode：子会话一律是全新会话（会话文件 pi 自己新建），
 * 这里只定工作目录、模型、思考强度。
 *
 * 工具不给子会话另定一套：不带 --tools 起，它就按 pi 自己的设置来（settings.json 里的
 * defaultTools，codemode / powershell / MCP 这些跟插件里那个会话一样都在）。
 */
import type { PanelLaunch } from "./runtimeTypes";
import type { TabaSpawnRequest } from "./tabaProtocol";

/** 算这个子会话怎么起时要用的输入。 */
export interface TabaSpawnResolutionInput {
    req: TabaSpawnRequest;
    /** 派活那个会话的工作目录。 */
    parentCwd: string;
    /** 派活那个会话正在用的模型（子会话没指定时跟着它）。 */
    parentModelId?: string;
    parentProvider?: string;
    /** 把相对路径变成绝对路径（各宿主自己实现）。 */
    resolvePath: (p: string) => string;
}

/** 算出来的结果。 */
export interface TabaSpawnResolution {
    /** 子会话的工作目录：派活时指定的 > 跟派活那个会话一样。 */
    cwd: string;
    /** 模型参数（可能带 :思考强度）；空串表示不指定，用插件的默认配置。 */
    modelSpec: string;
    /** 传给启动函数的模型覆盖；modelSpec 为空时是 undefined。 */
    modelOverride?: { provider?: string; modelId: string };
}

/**
 * 算优先级：
 *   工作目录     派活时指定的 > 跟派活那个会话一样
 *   模型         派活时指定的 > 派活那个会话正在用的
 *   思考强度     派活时指定的
 */
export function resolveTabaSpawn(input: TabaSpawnResolutionInput): TabaSpawnResolution {
    const { req } = input;
    const cwd = req.cwd ? input.resolvePath(req.cwd) : input.parentCwd;
    const modelId = req.model || input.parentModelId || "";
    const thinking = req.thinking || "";
    const modelSpec = modelId ? (thinking ? `${modelId}:${thinking}` : modelId) : "";
    // 写成 provider/model 的形式时，模型名里已经带着 provider 了，不要再单独传一遍
    const modelOverride = modelSpec
        ? { provider: modelSpec.includes("/") ? undefined : input.parentProvider || undefined, modelId: modelSpec }
        : undefined;
    return { cwd, modelSpec, modelOverride };
}

/** 子会话的启动要求：不领备用进程（参数不一样）、不加载"派子会话"那个扩展（不能再往下派）。 */
export function buildTabaLaunch(extraArgs: string[], cwd: string): PanelLaunch {
    return { extraArgs, skipSpare: true, noTaba: true, cwd };
}

/**
 * 派子会话那一步的几种变化。
 *
 * 判官（目标验收）跟普通子会话走的是同一条路，差别都在这里：
 *   普通子会话：进列表、写名录、跑完把结果交回父会话；
 *   判官：全都不做，只用 update_goal 报结论。
 */
export interface TabaSpawnOptions {
    /** 不写名录、不给模型看见、跑完不交回（见 TabaChild.hidden）。 */
    hidden?: boolean;
    /** 额外命令行参数（判官要 `-e <goal 扩展>` 才有 update_goal）。 */
    extraArgs?: string[];
    /** 任务原文直接发，不拼「任务 + 收尾要求」（判官的提示词自己就是完整的一轮）。 */
    rawTask?: boolean;
}
