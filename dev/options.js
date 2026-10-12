// @ts-nocheck
/**
 * options —— 两个调试命令（web:dev / web:shot）共用的命令行参数。
 *
 * 动作（--send / --wait / --shot 这些）按写在前面的先做，这样一条命令就能描述一整段操作：
 *   npm run web:shot -- --send "读一下说明.txt" --wait "说明" --shot read.png
 */

const OPTION_KEYS = {
    "--url": "url",
    "--port": "port",
    "--host": "host",
    "--cwd": "cwd",
    "--model": "model",
    "--provider": "provider",
    "--piPath": "piPath",
    "--theme": "theme",
    "--chrome": "chrome",
    "--width": "width",
    "--height": "height",
    "--out": "shotDir",
    "--timeout": "timeoutMs",
    "--script": "script",
};

const NUMBER_KEYS = new Set(["port", "width", "height", "timeoutMs"]);

const ACTIONS = new Set(["--sleep", "--send", "--click", "--eval", "--wait", "--wait-ms", "--shot"]);

function parseArgs(argv, options = {}) {
    const parsed = { actions: [], swallowActions: options.actions === false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") { parsed.help = true; continue; }
        if (arg === "--open") { parsed.open = true; continue; }
        if (arg === "--fake-pi") { parsed.fakePi = true; continue; }
        if (arg === "--headed") { parsed.headed = true; continue; }
        if (arg === "--keep") { parsed.keep = true; continue; }
        if (arg === "--skip-ready") { parsed.skipReady = true; continue; }

        if (arg === "--wait-answer") {
            // 这个动作后面的文字可给可不给（不给我就是"等随便一句回复"），所以要看一眼下一项
            if (parsed.swallowActions) { throw new Error("--wait-answer 是 web:shot 的动作。"); }
            const next = argv[i + 1];
            const value = next !== undefined && !next.startsWith("--") ? argv[++i] : "";
            parsed.actions.push({ kind: "wait-answer", value });
            continue;
        }

        if (ACTIONS.has(arg)) {
            if (parsed.swallowActions) {
                throw new Error(`${arg} 是 web:shot 的动作，web:dev 只负责起服务；要自动点界面请用 npm run web:shot。`);
            }
            const value = argv[++i];
            if (value === undefined) { throw new Error(`${arg} 后面要跟一个值。`); }
            parsed.actions.push({ kind: arg.slice(2), value });
            continue;
        }

        if (OPTION_KEYS[arg]) {
            const key = OPTION_KEYS[arg];
            const value = argv[++i];
            if (value === undefined) { throw new Error(`${arg} 后面要跟一个值。`); }
            parsed[key] = NUMBER_KEYS.has(key) ? Number(value) : value;
            continue;
        }

        if (arg.startsWith("--")) { throw new Error(`不认识这个参数：${arg}（用 --help 看用法）`); }
        throw new Error(`多出来的内容：${arg}（文字要引号包起来，比如 --send "你好"）`);
    }
    return parsed;
}

function usage() {
    return [
        "在浏览器里调试 Pi Chat（不用装插件、不用开 VS Code）",
        "",
        "  npm run web:dev                         起服务，浏览器自己打开屏幕上给的地址",
        "  npm run web:shot -- [动作…]             自动开浏览器、按动作点界面、截图到 dev/shots/",
        "",
        "常用参数：",
        "  --url URL          连一个已经开着的网页服务（配 npm run web:dev 用，不用再起一个）",
        "  --port N           自己起服务时的端口（默认 51999；0 = 随便挑一个）",
        "  --host ADDR        监听地址（默认 127.0.0.1）",
        "  --cwd DIR          会话的工作目录（默认 dev/.scratch）",
        "  --model M          覆盖模型（不填就用你 pi 自己的配置）",
        "  --provider P       覆盖 provider",
        "  --piPath PATH      覆盖 pi 可执行文件路径",
        "  --theme light|dark 界面颜色（默认 light）",
        "  --fake-pi          用假模型（dev/fakePi.js）：不调真模型，按剧本秒回，验界面不用等",
        "  --headed           显示浏览器窗口（默认无头）；配合 --keep 可以留在现场点",
        "  --chrome PATH      浏览器可执行文件（默认自动找 Chrome / Edge）",
        "  --width / --height 视口像素（默认 420x900，手机大小）",
        "  --out DIR          截图放哪儿（默认 dev/shots）",
        "  --timeout MS       等文字出现的默认上限（默认 60000）",
        "  --script FILE      用脚本文件代替命令行动作：module.exports = async (page) => { … }",
        "  --skip-ready       不等会话就绪就动手（调试「刚打开就发消息」这类启动时序问题时用）",
        "  --open             起完服务就用系统默认浏览器打开（web:dev）",
        "",
        "动作（按写的先后顺序执行）：",
        "  --sleep MS         等一会儿",
        "  --send TEXT        在输入框里输入并回车发送",
        "  --wait TEXT        等页面文字里出现这段文字（/正则/ 也行）",
        "  --wait-answer [TEXT] 等模型的回复（给文字就等回复里出现它；只看回复，不看自己发的话）",
        "  --wait-ms MS       等一段时间",
        "  --click SELECTOR   点一个元素（用 CSS 选择器）",
        "  --eval JS          在页面里跑一段脚本（结果打到屏幕上）",
        "  --shot NAME        截图（不给名字就按顺序编号）",
        "",
        "例子：",
        '  npm run web:shot -- --send "只回复两个字：收到" --wait-answer 收到 --shot reply.png',
        '  npm run web:shot -- --theme dark --click "#newSessionBtn" --shot dark.png',
        "  npm run web:shot -- --url http://127.0.0.1:51999/ --script dev/myFlow.js",
    ].join("\n");
}

module.exports = { parseArgs, usage };
