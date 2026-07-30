#!/usr/bin/env node
/**
 * 代码复用 / 重复度分析。
 *
 * 把源码分成三类：
 *   shared   —— 两个 app 共用的代码（src/shared、src/chat-ui，以及作为
 *               共用前端资源单一真源的 apps/vscode/media 资源）
 *   vscode   —— VSCode 插件专属（apps/vscode/src）
 *   electron —— Electron 客户端专属（apps/electron/src、apps/electron/renderer）
 *
 * 报告两个指标：
 *   1. 共享比 reuse = shared_LOC / total_LOC
 *      越高说明越多逻辑被抽出共用，重复越少。
 *   2. 跨 app 重复度 duplication
 *      对 vscode / electron 专属代码逐行归一化后取行集合交集，统计在
 *      两侧同时出现的代码行数。这些就是“本该进 shared 却被两边各写一份”
 *      的候选，重构时优先把它们下沉到 shared。
 *
 * 用法：
 *   node scripts/analyze-reuse.js            # 只打印报告
 *   node scripts/analyze-reuse.js --json     # 输出 JSON（便于 CI）
 *
 * 纯 Node，无外部依赖。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// ---- 文件分类规则 ---------------------------------------------------------
// media 里的共用前端资源（copy-assets 证明它们是两宿主的单一真源）
const SHARED_MEDIA = new Set([
    "chat.js", "chat.css", "marked.js", "highlight.js",
    "default-models.json", "settings.js",
]);

/** 返回该文件的分类，不符合则返回 null */
function classify(rel) {
    rel = rel.replace(/\\/g, "/");
    if (rel.startsWith("src/shared/")) return "shared";
    if (rel.startsWith("src/chat-ui/")) return "shared";
    if (rel.startsWith("apps/vscode/media/")) {
        const base = rel.slice("apps/vscode/media/".length);
        return SHARED_MEDIA.has(base) ? "shared" : null; // 其它 media 不计
    }
    if (rel.startsWith("apps/vscode/src/")) return "vscode";
    if (rel.startsWith("apps/electron/src/")) return "electron";
    if (rel.startsWith("apps/electron/renderer/")) return "electron";
    return null;
}

function listSourceFiles(dir, acc = []) {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        if (name.name === "node_modules" || name.name === "out" || name.name === "dist") continue;
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
            listSourceFiles(full, acc);
        } else {
            if (/\.(ts|tsx|js|cjs|mjs|css|json)$/.test(name.name)) acc.push(full);
        }
    }
    return acc;
}

// ---- 归一化 ---------------------------------------------------------------
function stripComments(line) {
    // 去掉行内 /* ... */
    let s = line.replace(/\/\*.*?\*\//g, "");
    // 去掉行尾 // ... 注释（粗暴，但对指标足够）
    s = s.replace(/\/\/.*$/, "");
    return s;
}

/** 归一化一行：去注释、压空白、去首尾空白。返回空串表示该行不参与比较 */
function normLine(line) {
    let s = stripComments(line).trim();
    if (!s) return "";
    s = s.replace(/\s+/g, " ");
    // 过滤过短/纯标点的行，避免 { } ; ( ) 这类噪声
    if (s.replace(/[\s{}()\[\];,]/g, "").length < 4) return "";
    return s;
}

function readNormalizedLines(file) {
    const txt = fs.readFileSync(file, "utf8");
    const set = new Set();
    const lines = [];
    for (const raw of txt.split(/\r?\n/)) {
        const n = normLine(raw);
        if (!n) continue;
        set.add(n);
        lines.push(n);
    }
    return { set, lines };
}

function physicalLoc(file) {
    const txt = fs.readFileSync(file, "utf8");
    let n = 0;
    for (const raw of txt.split(/\r?\n/)) {
        const s = stripComments(raw).trim();
        if (s) n++;
    }
    return n;
}

// ---- 主流程 ---------------------------------------------------------------
function main() {
    const asJson = process.argv.includes("--json");

    const files = listSourceFiles(ROOT);
    const buckets = { shared: [], vscode: [], electron: [] };
    for (const f of files) {
        const rel = path.relative(ROOT, f).replace(/\\/g, "/");
        const cat = classify(rel);
        if (cat) buckets[cat].push({ full: f, rel });
    }

    // 1. LOC 统计
    const loc = { shared: 0, vscode: 0, electron: 0 };
    for (const cat of Object.keys(buckets)) {
        for (const f of buckets[cat]) loc[cat] += physicalLoc(f.full);
    }
    const total = loc.shared + loc.vscode + loc.electron;
    const reuse = total > 0 ? loc.shared / total : 0;

    // 2. 跨 app 重复检测：vscode vs electron
    //    归一化行集合，先合并成两端的“行池”，求交集。
    const vscodePool = new Set();   // vscode 专属所有归一化行的并集
    const electronPool = new Set();
    const perFileVS = new Map();    // rel -> Set
    const perFileEL = new Map();
    for (const f of buckets.vscode) {
        const { set } = readNormalizedLines(f.full);
        perFileVS.set(f.rel, set);
        for (const l of set) vscodePool.add(l);
    }
    for (const f of buckets.electron) {
        const { set } = readNormalizedLines(f.full);
        perFileEL.set(f.rel, set);
        for (const l of set) electronPool.add(l);
    }

    const dupLines = [];
    for (const l of vscodePool) if (electronPool.has(l)) dupLines.push(l);
    const dupCount = dupLines.length;
    const dupVS = dupCount / Math.max(1, vscodePool.size);     // 占 vscode 独有行池的比例
    const dupEL = dupCount / Math.max(1, electronPool.size);

    // 3. 细化：哪些文件对贡献了最多的重复行（帮助定位重构目标）
    const pairStats = [];
    for (const [vRel, vSet] of perFileVS) {
        for (const [eRel, eSet] of perFileEL) {
            let c = 0;
            // 遍历较小集合
            const [a, b] = vSet.size <= eSet.size ? [vSet, eSet] : [eSet, vSet];
            for (const l of a) if (b.has(l)) c++;
            if (c > 0) pairStats.push({ vRel, eRel, dup: c,
                vShare: c / Math.max(1, vSet.size), eShare: c / Math.max(1, eSet.size) });
        }
    }
    pairStats.sort((a, b) => b.dup - a.dup);

    // 4. 输出
    const result = {
        loc, total, reuse,
        vscodeUniqueLines: vscodePool.size,
        electronUniqueLines: electronPool.size,
        duplicatedLines: dupCount,
        dupVsVscode: dupVS,
        dupVsElectron: dupEL,
        topPairs: pairStats.slice(0, 8).map(p => ({
            vscode: p.vRel, electron: p.eRel, duplicated: p.dup,
            shareInVscode: +p.vShare.toFixed(3),
            shareInElectron: +p.eShare.toFixed(3),
        })),
    };

    if (asJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
    }

    const pct = (x) => (x * 100).toFixed(1) + "%";
    console.log("");
    console.log("=== 代码复用 / 重复度分析 ===");
    console.log("");
    console.log("代码量（非空非注释物理行）：");
    console.log("  shared   : " + String(loc.shared).padStart(6) + "  (两 app 共用)");
    console.log("  vscode   : " + String(loc.vscode).padStart(6) + "  (VSCode 插件专属)");
    console.log("  electron : " + String(loc.electron).padStart(6) + "  (Electron 客户端专属)");
    console.log("  total    : " + String(total).padStart(6));
    console.log("");
    console.log("共享比 reuse = shared / total = " + pct(reuse));
    console.log("  → 越高越好：这部分逻辑只写一份。");
    console.log("");
    console.log("跨 app 重复行（归一化后两侧都出现的行）：");
    console.log("  重复行数          : " + dupCount);
    console.log("  占 vscode 专属行池 : " + pct(dupVS));
    console.log("  占 electron 专属行池: " + pct(dupEL));
    console.log("  → 这些是“两边各写一份”的候选，下沉到 shared 可消除重复。");
    console.log("");
    if (pairStats.length) {
        console.log("重复最集中的文件对（定位重构目标）：");
        for (const p of result.topPairs) {
            console.log(`  [${p.duplicated}行] ${p.vscode}`);
            console.log(`          ↔ ${p.electron}`);
            console.log(`          (占 vscode ${pct(p.shareInVscode)}，占 electron ${pct(p.shareInElectron)})`);
        }
    } else {
        console.log("未检测到跨 app 重复行。");
    }
    console.log("");

    // 5. 建议
    const advice = [];
    if (reuse < 0.4) advice.push("共享比偏低（<40%），考虑把更多两侧都用到的逻辑抽进 src/shared。");
    if (dupVS > 0.2 || dupEL > 0.2)
        advice.push("跨 app 重复度偏高（>20%），优先重构上面列出的文件对。");
    if (advice.length === 0)
        advice.push("复用状况良好，暂无迫切重构需求。");
    console.log("建议：");
    for (const a of advice) console.log("  - " + a);
    console.log("");
}
main();
