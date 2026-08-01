import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** pi 配置目录，遵循 PI_CODING_AGENT_DIR 环境变量。 */
export function agentDir(): string {
    return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** models.json 的绝对路径。 */
export function modelsJsonPath(): string {
    return path.join(agentDir(), "models.json");
}

/**
 * 内置默认模板（原 media/default-models.json，已并入内置常量）。
 */
const DEFAULT_MODELS_JSON = `{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:15721/v1",
      "apiKey": "xxx",
      "api": "openai-completions",
      "compat": {
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "gpt-5.5-2026-04-24",
          "name": "gpt-5.5",
          "reasoning": true,
          "input": ["image", "text"],
          "cost": { "input": 50, "output": 226, "cacheRead": 5, "cacheWrite": 0 },
          "contextWindow": 968000,
          "maxTokens": 128000
        },
        {
          "id": "glm-5.2",
          "name": "glm-5.2",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 8, "output": 28, "cacheRead": 2, "cacheWrite": 0 },
          "contextWindow": 980000,
          "maxTokens": 180000
        },
        {
          "id": "deepseek-v4-pro",
          "name": "deepseek-v4-pro",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 3, "output": 6, "cacheRead": 0.025, "cacheWrite": 0 },
          "contextWindow": 968000,
          "maxTokens": 384000
        },
        {
          "id": "deepseek-v4-flash",
          "name": "deepseek-v4-flash",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 1, "output": 2, "cacheRead": 0.02, "cacheWrite": 0 },
          "contextWindow": 968000,
          "maxTokens": 384000
        },
        {
          "id": "claude-opus-4-8",
          "name": "claude-opus-4-8",
          "reasoning": true,
          "input": ["image", "text"],
          "cost": { "input": 36, "output": 180, "cacheRead": 3.6, "cacheWrite": 45 },
          "contextWindow": 968000,
          "maxTokens": 64000
        }
      ]
    }
  }
}
`;

/** 默认 models 模板（用户 models.json 不存在时使用）。 */
export function defaultModelsJson(): string {
    return DEFAULT_MODELS_JSON;
}

/** 读取 models.json，不存在时返回默认模板。返回 { content, existed }。 */
export function readModelsJson(): { content: string; existed: boolean; path: string } {
    const p = modelsJsonPath();
    try {
        if (fs.existsSync(p)) {
            return { content: fs.readFileSync(p, "utf8"), existed: true, path: p };
        }
    } catch {
        /* fallthrough */
    }
    return { content: defaultModelsJson(), existed: false, path: p };
}

/** 写入 models.json（自动创建父目录）。写入前校验 JSON 合法性。 */
export function writeModelsJson(content: string): { ok: boolean; error?: string } {
    // 校验 JSON
    try {
        JSON.parse(content);
    } catch (e: any) {
        return { ok: false, error: "JSON 格式错误: " + e.message };
    }
    const p = modelsJsonPath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: "写入失败: " + e.message };
    }
}
