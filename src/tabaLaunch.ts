/**
 * 派子会话（taba）：把"派活请求 + 角色定义"算成"子会话该怎么起"。
 *
 * 只算，不碰文件、不碰 vscode：会话文件、提示词文件由调用方（控制器）先写好再传进来。
 * 这样每一条优先级规则都能单测。
 */
import type { PanelLaunch } from "./runtimeTypes";
import type { TabaSpawnRequest } from "./tabaProtocol";
import { normalizeListValue, type TabaRole, type TabaSessionMode } from "./tabaRoles";
import { buildTaskText, resolveSessionMode } from "./tabaTask";

/** 算这个子会话怎么起时要用的输入。 */
export interface TabaSpawnResolutionInput {
    req: TabaSpawnRequest;
    /** 角色（可选）；派活时指名了但没有这个角色的话，调用方应该已经先回话了。 */
    role?: TabaRole;
    /** 派活那个会话的工作目录。 */
    parentCwd: string;
    /** 派活那个会话正在用的模型（子会话没指定时跟着它）。 */
    parentModelId?: string;
    parentProvider?: string;
    /** 把相对路径变成绝对路径（各宿主自己实现，测试里塞个假的）。 */
    resolvePath: (p: string) => string;
}

/** 算出来的结果。 */
export interface TabaSpawnResolution {
    /** 子会话的工作目录：派活时指定的 > 角色定的 > 跟派活那个会话一样。 */
    cwd: string;
    /** 子会话的内容从哪来：全新 / 只记父子关系 / 带上派活那边的对话。 */
    mode: TabaSessionMode;
    /** 工具白名单（已经归一化成 read,bash）；undefined 表示不限制。 */
    tools?: string;
    /** 模型参数（可能带 :思考强度）；空串表示不指定，用插件的默认配置。 */
    modelSpec: string;
    /** 传给启动函数的模型覆盖；modelSpec 为空时是 undefined。 */
    modelOverride?: { provider?: string; modelId: string };
    /** 角色说明是不是要跟任务一起发给子会话（false 表示走系统提示词那条路）。 */
    bodyInTask: boolean;
}

/**
 * 算优先级：
 *   工作目录     派活时指定的 > 角色定的 > 跟派活那个会话一样
 *   会话内容     派活时的 fork > 角色定的 session-mode > 全新会话
 *   模型         派活时指定的 > 角色定的 > 派活那个会话正在用的
 *   思考强度     派活时指定的 > 角色定的
 *   工具白名单   派活时指定的 > 角色定的 > 不限制
 */
export function resolveTabaSpawn(input: TabaSpawnResolutionInput): TabaSpawnResolution {
    const { req, role } = input;
    const cwd = req.cwd
        ? input.resolvePath(req.cwd)
        : (role?.cwd ? input.resolvePath(role.cwd) : input.parentCwd);
    const mode = resolveSessionMode({ fork: req.fork }, role);
    const tools = normalizeListValue(req.tools || role?.tools || "");
    const modelId = req.model || role?.model || input.parentModelId || "";
    const thinking = req.thinking || role?.thinking || "";
    const modelSpec = modelId ? (thinking ? `${modelId}:${thinking}` : modelId) : "";
    // 写成 provider/model 的形式时，模型名里已经带着 provider 了，不要再单独传一遍
    const modelOverride = modelSpec
        ? { provider: modelSpec.includes("/") ? undefined : input.parentProvider || undefined, modelId: modelSpec }
        : undefined;
    // 角色文件里明确写了"说明放系统提示词里"（append / replace）才走那条路，否则跟任务一起发
    const bodyInTask = !(role && role.body && role.systemPromptMode);
    return { cwd, mode, tools, modelSpec, modelOverride, bodyInTask };
}

/**
 * 子会话启动 pi 时的额外参数。
 * @param sessionFile 带上下文那两档：先写好的子会话文件（pi 用 --session 打开它）
 * @param promptFile 角色说明走系统提示词时写好的文件
 * @param systemPromptMode append = 加在默认提示词后面（默认），replace = 整个换掉
 */
export function buildTabaExtraArgs(p: {
    sessionFile?: string;
    promptFile?: string;
    systemPromptMode?: "append" | "replace";
    tools?: string;
}): string[] {
    const args: string[] = [];
    if (p.sessionFile) { args.push("--session", p.sessionFile); }
    if (p.promptFile) {
        args.push(p.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", p.promptFile);
    }
    if (p.tools) { args.push("--tools", p.tools); }
    return args;
}

/** 子会话的启动要求：不领备用进程（参数不一样）、不加载"派子会话"那个扩展（不能再往下派）。 */
export function buildTabaLaunch(extraArgs: string[], cwd: string): PanelLaunch {
    return { extraArgs, skipSpare: true, noTaba: true, cwd };
}

/** 发给子会话的第一条消息。 */
export function buildTabaTaskText(p: { role?: TabaRole; bodyInTask: boolean; task: string }): string {
    return buildTaskText({ roleBody: p.role?.body, bodyInTask: p.bodyInTask, skills: p.role?.skills, task: p.task });
}
