/**
 * 派子会话（taba）：把"派活请求"算成"子会话该怎么起"。
 *
 * 只算，不碰文件、不碰 vscode：子会话一律是全新会话（会话文件 pi 自己新建），
 * 这里只定工作目录、模型、工具白名单。这样每一条优先级规则都能单测。
 */
import type { PanelLaunch } from "./runtimeTypes";
import type { TabaSpawnRequest } from "./tabaProtocol";
import { buildTaskText } from "./tabaTask";

/** 算这个子会话怎么起时要用的输入。 */
export interface TabaSpawnResolutionInput {
    req: TabaSpawnRequest;
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
    /** 子会话的工作目录：派活时指定的 > 跟派活那个会话一样。 */
    cwd: string;
    /** 工具白名单（已经归一化成 read,bash 这种没有空格的形式）；undefined 表示不限制。 */
    tools?: string;
    /** 模型参数（可能带 :思考强度）；空串表示不指定，用插件的默认配置。 */
    modelSpec: string;
    /** 传给启动函数的模型覆盖；modelSpec 为空时是 undefined。 */
    modelOverride?: { provider?: string; modelId: string };
}

/** 把 `read, bash` 这种列表归一化成 `read,bash`；空列表返回 undefined。 */
export function normalizeListValue(raw?: string): string | undefined {
    if (!raw) { return undefined; }
    const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) { return undefined; }
    // 去重但保持顺序（写重了也不至于传两个一样的）
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of items) {
        const key = it.toLowerCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(it);
    }
    return out.join(",");
}

/**
 * 算优先级：
 *   工作目录     派活时指定的 > 跟派活那个会话一样
 *   模型         派活时指定的 > 派活那个会话正在用的
 *   思考强度     派活时指定的
 *   工具白名单   派活时指定的 > 不限制
 */
export function resolveTabaSpawn(input: TabaSpawnResolutionInput): TabaSpawnResolution {
    const { req } = input;
    const cwd = req.cwd ? input.resolvePath(req.cwd) : input.parentCwd;
    const tools = normalizeListValue(req.tools);
    const modelId = req.model || input.parentModelId || "";
    const thinking = req.thinking || "";
    const modelSpec = modelId ? (thinking ? `${modelId}:${thinking}` : modelId) : "";
    // 写成 provider/model 的形式时，模型名里已经带着 provider 了，不要再单独传一遍
    const modelOverride = modelSpec
        ? { provider: modelSpec.includes("/") ? undefined : input.parentProvider || undefined, modelId: modelSpec }
        : undefined;
    return { cwd, tools, modelSpec, modelOverride };
}

/** 子会话启动 pi 时的额外参数。 */
export function buildTabaExtraArgs(p: { tools?: string }): string[] {
    const args: string[] = [];
    if (p.tools) { args.push("--tools", p.tools); }
    return args;
}

/** 子会话的启动要求：不领备用进程（参数不一样）、不加载"派子会话"那个扩展（不能再往下派）。 */
export function buildTabaLaunch(extraArgs: string[], cwd: string): PanelLaunch {
    return { extraArgs, skipSpare: true, noTaba: true, cwd };
}
