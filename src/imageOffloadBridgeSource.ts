/**
 * 「会话里的截图挪出去」这个 pi 扩展文件的源码。
 *
 * 插件启动时把下面这份源码写到 <pichatDir>/image-bridge-<插件版本>.ts，
 * 每个会话的 pi 进程启动时都用 `-e <那个文件>` 加载它（跟另几套桥一样，见 bridgeAssets.ts）。
 *
 * 为什么要它：pi 把工具读到的截图整张 base64 存进会话文件（一条 2340×1080 的截图就 2~3 MB），
 * 几十条就是上百 MB —— 打开那条会话得把整份内容搬一遍、解析一遍，要等好几秒到十几秒。
 *
 * 注意不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，用户在终端里手跑的 pi
 * 也会被塞上这个行为 —— 这是只有插件的会话里才该发生的事。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留（那行标记里就有 JSON 的路径）。
 */

export const IMAGE_BRIDGE_SOURCE = String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：会话里的截图不整张写进会话文件，写到一个单独的文件里，会话里只留一行标记。
 *
 * 改两处：
 *   - message_end：这条消息里的图先写到 ~/.pi/agent/images/<会话 id>/ 下，再把图块换成一行
 *     文字：[图片已挪出会话] {"path":"…","mimeType":"image/png"}（要看就 read 这个文件）
 *   - context：每次发请求前，从末尾往前数最近 KEEP_RECENT 条带图的还原成真图，更早的留文字。
 *     所以「刚截的几张」模型还看得见，老的既不占上下文也不占文件。
 *
 * 图写不进去就原样留着：宁可文件大，不能丢东西。
 *
 * 会话文件里已经有的图不会自己变小：仓库里 scripts/offload-session-images.mjs 能清一次。
 * 插件那边认这行标记：网页端照旧把图给你画出来（见 src/messageUtils.ts）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 图片落在哪儿：一个会话一个目录。清理脚本写的是同一个地方、同一种标记。 */
const STORE_ROOT = join(homedir(), ".pi", "agent", "images");

/** 标记文字的开头。后半截是 JSON（path / mimeType），插件那边也按这个认。 */
const MARK = "[图片已挪出会话] ";

/** 最近这么多条「带图的消息」在请求里还原成真图，更早的只留文字。 */
const KEEP_RECENT = 3;

/** 还原时读过的那几张图留在内存里，免得每次请求都重新读盘。 */
const CACHE_MAX = 6;

/** 读出来的图（base64）留一小份在内存里；读不到记 null（文件被删了）。 */
const cache = new Map();

function isImageBlock(block) {
    return !!block && block.type === "image" && typeof block.data === "string" && block.data.length > 0;
}

function extOf(mimeType) {
    const m = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType || "");
    const sub = (m ? m[1] : "png").toLowerCase().replace(/^x-/, "");
    if (sub === "jpeg") { return "jpg"; }
    return /^[a-z0-9]{1,6}$/.test(sub) ? sub : "bin";
}

/** 文件名里只留能放进任何文件系统的东西。 */
function safeName(text) {
    return String(text).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "x";
}

function markerText(path, mimeType) {
    return MARK + JSON.stringify({ path, mimeType }) + "（要看就 read 这个文件）";
}

/** 这一块文字是不是我们写的标记；是就解出路径来。 */
function markerOf(block) {
    if (!block || block.type !== "text" || typeof block.text !== "string") { return null; }
    if (!block.text.startsWith(MARK)) { return null; }
    const rest = block.text.slice(MARK.length);
    const end = rest.lastIndexOf("}");
    if (end < 0) { return null; }
    try {
        const parsed = JSON.parse(rest.slice(0, end + 1));
        return typeof parsed?.path === "string" && parsed.path ? { path: parsed.path, mimeType: parsed.mimeType || "image/png" } : null;
    } catch {
        return null;
    }
}

async function loadImage(marker) {
    const hit = cache.get(marker.path);
    if (hit !== undefined) {
        return hit ? { type: "image", data: hit.data, mimeType: hit.mimeType } : undefined;
    }
    let block;
    try {
        const data = await readFile(marker.path);
        block = { type: "image", data: data.toString("base64"), mimeType: marker.mimeType };
        if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next();
            if (!oldest.done) { cache.delete(oldest.value); }
        }
        cache.set(marker.path, { data: block.data, mimeType: marker.mimeType });
    } catch {
        cache.set(marker.path, null);   // 文件被删了 / 读不了：就留那行文字
        block = undefined;
    }
    return block;
}

/** 把一条消息里的图搬到磁盘，换成一行动作。没图就返回 undefined（不动这条消息）。 */
async function offloadMessage(message, sessionId) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some(isImageBlock)) { return undefined; }
    const dir = join(STORE_ROOT, safeName(sessionId));
    const base = safeName(String(message.toolCallId || message.timestamp || Date.now()));
    try {
        await mkdir(dir, { recursive: true });
    } catch {
        return undefined;
    }
    const next = [];
    let index = 0;
    for (const block of content) {
        if (!isImageBlock(block)) {
            next.push(block);
            continue;
        }
        index += 1;
        const mimeType = typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png";
        const file = join(dir, base + "-" + index + "." + extOf(mimeType));
        try {
            await writeFile(file, Buffer.from(block.data, "base64"));
        } catch {
            next.push(block);   // 写不进去就原样留着
            continue;
        }
        next.push({ type: "text", text: markerText(file, mimeType) });
    }
    return { ...message, content: next };
}

/**
 * 这次请求里哪些标记还原成真图：从末尾往前数最近 KEEP_RECENT 条带图的消息。
 * 一条消息里有几张就还原几张（一次并行读好几张图的场景）。
 */
async function restoreRecent(messages) {
    const out = messages.slice();
    let left = KEEP_RECENT;
    let changed = false;
    for (let i = messages.length - 1; i >= 0 && left > 0; i -= 1) {
        const message = messages[i];
        if (!Array.isArray(message?.content)) { continue; }
        if (!message.content.some(function (block) { return markerOf(block); })) { continue; }
        left -= 1;
        const content = message.content.slice();
        for (let j = 0; j < content.length; j += 1) {
            const marker = markerOf(content[j]);
            if (!marker) { continue; }
            const block = await loadImage(marker);
            if (block) { content[j] = block; }
        }
        out[i] = { ...message, content };
        changed = true;
    }
    return changed ? out : undefined;
}

export default function (pi) {
    pi.on("message_end", async function (event, ctx) {
        try {
            const message = event.message;
            if (message?.role !== "toolResult" && message?.role !== "user") { return; }
            const sessionId = ctx.sessionManager.getSessionId();
            if (!sessionId) { return; }
            const replaced = await offloadMessage(message, sessionId);
            if (replaced) { return { message: replaced }; }
        } catch {
            // 扩展出什么事都不能拖住对话：留着原样（图还在会话里）就行
        }
    });

    pi.on("context", async function (event) {
        try {
            const messages = await restoreRecent(event.messages);
            if (messages) { return { messages }; }
        } catch {
            // 还原失败就按文件里那样（文字标记）发出去，模型最多看不见那几张老图
        }
    });
}
`;
