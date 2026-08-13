import { exec } from "child_process";
import * as http from "http";
import * as https from "https";
import { URL } from "url";

/** 探测到的单个模型信息。 */
export interface ProbeModel {
    id: string;
    name?: string;
}

export type ProbeResult =
    | { ok: true; models: ProbeModel[] }
    | { ok: false; error: string };

/**
 * 解析 models.json 中的 apiKey 字段：
 * - `!` 前缀：执行 shell 命令，取 stdout
 * - 形如环境变量名且存在：取环境变量值
 * - 其余：字面量
 */
export async function resolveApiKey(raw: string): Promise<string> {
    const key = (raw || "").trim();
    if (!key) { return ""; }
    if (key.startsWith("!")) {
        const cmd = key.slice(1).trim();
        return new Promise<string>((resolve, reject) => {
            exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
                if (err) { reject(new Error(`API Key 命令执行失败：${err.message}`)); }
                else { resolve(stdout.trim()); }
            });
        });
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] !== undefined) {
        return process.env[key] as string;
    }
    return key;
}

function httpGet(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        let u: URL;
        try { u = new URL(url); } catch { reject(new Error(`无效的 URL：${url}`)); return; }
        const lib = u.protocol === "http:" ? http : https;
        const req = lib.get(u, { headers, timeout: timeoutMs }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.on("timeout", () => { req.destroy(new Error(`请求超时（${timeoutMs / 1000}s）`)); });
        req.on("error", reject);
    });
}

/**
 * 从响应体提取模型列表，兼容多种格式：
 * - OpenAI 系：`{data: [{id}]}` 或裸数组 `[{id}]`
 * - Anthropic：`{models: [{id, display_name}]}`
 * - Google：`{models: [{name: "models/gemini-..."}]}`（去掉 `models/` 前缀）
 */
export function extractModels(body: unknown): ProbeModel[] {
    let arr: unknown[] | null = null;
    if (Array.isArray(body)) { arr = body; }
    else if (body && typeof body === "object") {
        const o = body as Record<string, unknown>;
        if (Array.isArray(o.data)) { arr = o.data; }
        else if (Array.isArray(o.models)) { arr = o.models; }
    }
    if (!arr) { return []; }
    const out: ProbeModel[] = [];
    for (const item of arr) {
        if (!item || typeof item !== "object") { continue; }
        const it = item as Record<string, unknown>;
        let id =
            typeof it.id === "string" ? it.id
            : typeof it.model === "string" ? it.model
            : typeof it.name === "string" ? it.name
            : "";
        if (!id) { continue; }
        id = id.replace(/^models\//, "");
        const name = typeof it.display_name === "string" && it.display_name ? it.display_name : undefined;
        out.push(name ? { id, name } : { id });
    }
    return out;
}

/**
 * 探测 provider 的模型列表：GET {baseUrl}/models。
 * 鉴权方式按 api 类型选择（Bearer / x-api-key / query key）。
 */
export async function probeProviderModels(
    baseUrl: string,
    apiKeyRaw: string,
    api?: string,
): Promise<ProbeResult> {
    const base = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) { return { ok: false, error: "Base URL 为空，请先填写" }; }
    let apiKey = "";
    try { apiKey = await resolveApiKey(apiKeyRaw); }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }

    let url = `${base}/models`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
        if (api === "anthropic-messages") {
            headers["x-api-key"] = apiKey;
            headers["anthropic-version"] = "2023-06-01";
        } else if (api === "google-generative-ai") {
            url += `?key=${encodeURIComponent(apiKey)}`;
        } else {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }
    }

    try {
        const { status, body } = await httpGet(url, headers, 15000);
        if (status < 200 || status >= 300) {
            let detail = "";
            try {
                const j = JSON.parse(body);
                detail = j?.error?.message || j?.message || "";
            } catch { /* 忽略 */ }
            return { ok: false, error: `HTTP ${status}${detail ? "：" + detail : ""}（GET ${url}）` };
        }
        let json: unknown;
        try { json = JSON.parse(body); }
        catch { return { ok: false, error: "响应不是有效的 JSON" }; }
        return { ok: true, models: extractModels(json) };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}
