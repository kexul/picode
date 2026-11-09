/**
 * stripText —— 发出去之前把注释去掉（源码不动，还是那份带注释的）。
 *
 * 为什么值得做（都是量出来的，brotli 之后的字节）：
 *
 *   chat.js        192 KB → 93 KB   （注释与空行占原文 40%，中文注释 brotli 也压不太动）
 *   chat.css        42 KB → 15 KB
 *   browserTheme.css 3.3 KB → 0.9 KB
 *   browserBridge.js 18 KB → 11 KB
 *
 * 合起来省一百 KB 上下 —— 比“把大文件拆成按需加载”省得还多，而且不会踩“用到时还没拉到”那种坑。
 *
 * 规则（保守，宁可不删）：
 *   - **只删“整行都是注释”的行和空行**：行的第一个非空白字符是 `//`、或者 `/*` 开头的块注释。
 *     行尾那种 `const x = 1; // 说明` 一律留着 —— 要删它得先分清正则字面量里的 `//`，
 *     为一个注释冒改坏代码的风险不值得。
 *   - 多行字符串 / 模板串里的行不动（状态机看着引号走，见 {@link stripJsComments}）。
 *   - 整行删掉以后**行号会错位**：浏览器控制台报的是去掉之后的第几行。
 *     （CSS 没有这个问题；JS 真要对着报错找源码，就用 media/ 里那份原本的。）
 */

/** 这份资源发出去之前要不要去注释（界面文件里的脚本与样式）。 */
export function isStrippable(name: string): boolean {
    return /\.(js|css)$/i.test(name);
}

/** 按扩展名分派：脚本走状态机，样式直接删块注释。 */
export function stripForWire(name: string, text: string): string {
    if (/\.css$/i.test(name)) { return stripCssComments(text); }
    if (/\.js$/i.test(name)) { return stripJsComments(text); }
    return text;
}

/** 样式里的注释：`/* … *\/` 整块删掉（CSS 没有注释以外用 /* 的地方，也没有行号问题）。 */
export function stripCssComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * 脚本里的注释：只删“整行都是注释”的行与空行。
 *
 * 状态机只认三件事：普通代码、字符串/模板串（跨行的只有模板串）、块注释。
 * 行内注释、正则字面量里像注释的片段一律不动。
 */
export function stripJsComments(source: string): string {
    const lines = source.split("\n");
    const out: string[] = [];
    /** 跨行状态：normal / template（模板串还没收）/ block（块注释还没收）。 */
    let mode: "normal" | "template" | "block" = "normal";
    for (const line of lines) {
        const trimmed = line.trim();
        if (mode === "block") {
            const end = line.indexOf("*/");
            if (end < 0) { continue; }                       // 整行还在注释里
            mode = "normal";
            const rest = line.slice(end + 2);
            if (rest.trim()) { out.push(rest); }              // 注释后面还有代码（少见）：留着
            else { continue; }
            continue;
        }
        if (mode === "template") {
            out.push(line);                                   // 模板串里的行原样留
            mode = templateStateAfter(line, true);
            continue;
        }
        if (!trimmed) { continue; }                            // 空行
        if (trimmed.startsWith("//")) { continue; }            // 整行注释
        if (trimmed.startsWith("/*")) {
            if (line.indexOf("*/", line.indexOf("/*") + 2) < 0) { mode = "block"; continue; }
            // 一行里就收了的块注释：后面还有代码就留后面那段，没有就整行删
            const rest = line.slice(line.indexOf("*/") + 2);
            if (rest.trim()) { out.push(rest); }
            continue;
        }
        out.push(line);
        mode = templateStateAfter(line, false);
    }
    return out.join("\n");
}

/**
 * 扫完这一行之后，是不是还停在模板串里。
 *
 * 只认引号与转义：手写的界面脚本里模板串极少套 ${…里面再套反引号}，真套了也只是
 * “多留几行注释”，不会删错代码。字符串（单/双引号）不跨行，扫到行尾就复位。
 * @param alreadyInside 这一行本来就属于模板串（上几行没收）
 */
function templateStateAfter(line: string, alreadyInside: boolean): "normal" | "template" {
    let quote = alreadyInside ? "`" : "";
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
            if (c === "\\") { i += 1; continue; }             // 转义：下一个字符不算
            if (c === quote) { quote = ""; }
            continue;
        }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === "`") { quote = "`"; continue; }
        // 行内的 // 注释：后面的引号都当注释内容，别让它把状态带歪
        if (c === "/" && line[i + 1] === "/") { break; }
    }
    // 单/双引号不跨行：扫完还挂着的那种当没开（下一行重新算）
    return quote === "`" ? "template" : "normal";
}
