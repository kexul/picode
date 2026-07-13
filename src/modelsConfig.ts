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
 * 内置兜底模板。仅当打包的 media/default-models.json 读取失败时使用。
 * 请以 media/default-models.json 作为标准 models（会被打包进插件）。
 */
const FALLBACK_MODELS_JSON = `{
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
        }
      ]
    }
  }
}
`;

/** 插件根目录，由 extension.ts 在激活时注入。 */
let extensionRoot: string | undefined;

/** 由扩展激活时调用，用于定位打包资源（media/default-models.json）。 */
export function setExtensionRoot(root: string): void {
    extensionRoot = root;
}

/**
 * 读取打包在插件中的标准 models.json 模板。
 * 优先读取 media/default-models.json，失败时回退到内置字符串。
 */
export function defaultModelsJson(): string {
    if (extensionRoot) {
        const p = path.join(extensionRoot, "media", "default-models.json");
        try {
            if (fs.existsSync(p)) {
                return fs.readFileSync(p, "utf8");
            }
        } catch {
            /* fallthrough to fallback */
        }
    }
    return FALLBACK_MODELS_JSON;
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
