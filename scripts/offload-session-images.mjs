#!/usr/bin/env node
/**
 * 把一条已经存在的会话文件里的大图挪出去（跟插件自带的 image-bridge 扩展同一套目录与标记）。
 * 挪完会话文件小几十倍，打开它就不用等十几秒；图还在 ~/.pi/agent/images/ 下。
 *
 * 只有「以前存下来的老会话」需要它：新会话的图在存的时候就被扩展挪出去了。
 * 插件界面上没有这个功能，要用就在仓库里敲：
 *
 *   node scripts/offload-session-images.mjs <会话文件.jsonl>          # 只看会动什么
 *   node scripts/offload-session-images.mjs <会话文件.jsonl> --apply  # 真动
 *
 * 两条不能省的保险：
 *   - 会话刚被写过（60 秒内）就不动：pi 可能正往里面追加，读一半写回去会丢消息（--force 强来）。
 *   - 原文件先复制一份到 <文件>.bak（已经有了就停下，别覆盖上一次的备份）。
 *
 * 所有大于 2 MB 的会话一次扫完：
 *   node scripts/offload-session-images.mjs --all --apply
 */
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const STORE_ROOT = join(homedir(), ".pi", "agent", "images");
const MARK = "[图片已挪出会话] ";
const FRESH_MS = 60_000;

function extOf(mimeType) {
    const m = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType || "");
    const sub = (m ? m[1] : "png").toLowerCase().replace(/^x-/, "");
    if (sub === "jpeg") { return "jpg"; }
    return /^[a-z0-9]{1,6}$/.test(sub) ? sub : "bin";
}

function safeName(text) {
    return String(text).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "x";
}

function markerText(path, mimeType) {
    return MARK + JSON.stringify({ path, mimeType }) + "（要看就 read 这个文件）";
}

const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";

/**
 * 处理一条会话文件。
 * @param file 会话文件
 * @param opts.apply 真写；否则只算
 * @param opts.force 不管「刚写过」那道保险
 */
async function cleanFile(file, opts) {
    const before = await stat(file);
    if (!opts.force && Date.now() - before.mtimeMs < FRESH_MS) {
        console.log(`跳过（${Math.round((Date.now() - before.mtimeMs) / 1000)} 秒前刚被写过，pi 可能正连着）：${file}`);
        return { skipped: true };
    }

    try {
        await stat(file + ".bak");
        console.log(`跳过（已经有一份备份 ${file}.bak，先把它挪走再来）：${file}`);
        return { skipped: true };
    } catch { /* 没有备份，接着做 */ }

    let sessionId = "";
    let images = 0;
    let imageBytes = 0;
    let touchedLines = 0;
    const writes = [];          // { file, data }

    const tmp = file + ".tmp";
    const out = opts.apply ? createWriteStream(tmp) : null;

    const input = createReadStream(file);
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
        let replaced = line;
        let parsed;
        try { parsed = JSON.parse(line); } catch { parsed = undefined; }
        if (parsed && typeof parsed === "object" && !sessionId && parsed.type === "session" && typeof parsed.id === "string") {
            sessionId = parsed.id;
        }
        const content = parsed && parsed.message && Array.isArray(parsed.message.content) ? parsed.message.content : null;
        if (content && content.some((b) => b && b.type === "image" && typeof b.data === "string" && b.data.length > 0)) {
            const dir = join(STORE_ROOT, safeName(sessionId || "session"));
            const base = safeName(String(parsed.id || parsed.message.toolCallId || parsed.message.timestamp || "m"));
            const next = [];
            let index = 0;
            for (const block of content) {
                if (!block || block.type !== "image" || typeof block.data !== "string" || block.data.length === 0) {
                    next.push(block);
                    continue;
                }
                index += 1;
                const mimeType = typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png";
                const target = join(dir, `${base}-${index}.${extOf(mimeType)}`);
                imageBytes += block.data.length;
                images += 1;
                if (opts.apply) { writes.push({ file: target, data: Buffer.from(block.data, "base64") }); }
                next.push({ type: "text", text: markerText(target, mimeType) });
            }
            replaced = JSON.stringify({ ...parsed, message: { ...parsed.message, content: next } });
            touchedLines += 1;
        }
        if (out) {
            if (!out.write(replaced + "\n")) {
                await new Promise((done) => out.once("drain", done));
            }
        }
    }
    if (out) {
        await new Promise((done) => out.end(done));
    }

    if (!images) {
        console.log(`没有图，不用动：${file}`);
        if (opts.apply) { await removeIfExists(tmp); }
        return { skipped: true };
    }

    const after = opts.apply ? await stat(tmp) : null;
    console.log(`${opts.apply ? "已处理" : "将处理"}：${file}`);
    console.log(`  ${touchedLines} 条消息里的 ${images} 张图，共 ${mb(imageBytes)}（base64 字符数）`);
    console.log(`  文件：${mb(before.size)}${after ? " → " + mb(after.size) : "（现在这个大小）"}`);
    console.log(`  图落到：${join(STORE_ROOT, safeName(sessionId || "session"))}`);

    if (!opts.apply) {
        console.log("  （只是看看。要真动，加上 --apply）");
        return { images, imageBytes, sizeBefore: before.size };
    }

    for (const item of writes) {
        await mkdir(dirname(item.file), { recursive: true });
        await writeFile(item.file, item.data);
    }
    await copyFile(file, file + ".bak");
    await rename(tmp, file);
    console.log(`  完成。原文件留在 ${file}.bak`);
    return { images, imageBytes, sizeBefore: before.size, sizeAfter: after.size };
}

async function removeIfExists(file) {
    try { await unlink(file); } catch { /* 没有就算了 */ }
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const force = args.includes("--force");
    const all = args.includes("--all");
    const paths = args.filter((a) => !a.startsWith("--"));
    if (all) {
        // 会话目录：~/.pi/agent/sessions/--<路径>--/*.jsonl
        const root = join(homedir(), ".pi", "agent", "sessions");
        const dirs = await readdir(root, { withFileTypes: true });
        for (const dir of dirs) {
            if (!dir.isDirectory()) { continue; }
            const full = join(root, dir.name);
            const files = (await readdir(full)).filter((f) => f.endsWith(".jsonl"));
            for (const name of files) {
                const size = (await stat(join(full, name))).size;
                if (size < 2 * 1024 * 1024) { continue; }   // 小的不用费这个劲
                await cleanFile(join(full, name), { apply, force });
            }
        }
        return;
    }
    if (!paths.length) {
        console.log("用法：node scripts/offload-session-images.mjs <会话文件.jsonl> [--apply] [--force]");
        console.log("      node scripts/offload-session-images.mjs --all [--apply]   # 所有大于 2 MB 的会话");
        process.exitCode = 1;
        return;
    }
    for (const item of paths) {
        await cleanFile(resolve(item), { apply, force });
    }
}

await main();
