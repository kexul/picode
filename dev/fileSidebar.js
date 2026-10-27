// @ts-nocheck
/**
 * fileSidebar —— 验「点消息流里的文件链接，左边开出一列看文件」。
 *
 *   npm run web:shot -- --fake-pi --script dev/fileSidebar.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 往页面里投带文件链接的假消息（照 dev/toolRow.js 的做法），点它，读左边那一列的 DOM：
 *      文件内容、行号、停在链接说的那一行并高亮；看过的文件在这一列头上排成一排标签——
 *      点另一个文件新开一个标签、原来那个还留着，点已经开着的文件切回那个标签并按这次
 *      链接说的行滚过去（不新开重复标签），点标签上那颗叉关掉它，全关光后这一列不收起、
 *      里面留一句提示；切标签不重读文件、也不重画（每个标签各自留着自己那一块正文，
 *      切回来原样摆上，见 chat.js 的 fileTabPage）；
 *      第一个标签是「目录」（当前会话的目录，悬停提示给这一层的全路径；没有关闭那颗叉）；
 *      这一列头上不写路径——最上面那一行就是标签条，「收起」那颗叉钉在它右端；
 *      标签一律一样高（有文件的标签里那颗叉撑着高度，只剩「目录」自己开着时也不许缩成一薄条）：
 *      点文件链接开的文件排在它后面的新标签里、不顶掉它；这一列空着（刚打开、刷新页面）
 *      先看到的就是它；从它那一格里点进子目录、点开文件跟票 05 是同一套清单；
 *      目录不占标签——点目录链接、点清单里的子目录都在这一格里发生，清单最上面一行「上一层」
 *      往回退（到会话目录本身那一层就没有这一行了），刷新页面时这一格回到会话目录本身，
 *      切会话时摆出那个会话自己那一份（每个会话各记一份开过的标签，切回去原样回来）；
 *      换个会话不把上一个会话看过的文件内容留在面板里；
 *      ≥1200px 常驻在左边、窄了滑入、点外面收起；手机上两块侧边栏互斥；
 *      顶条左边那颗按钮点开点收、刷新后还是刚才的样子；
 *      目录外 / 不存在 / 超过 2 MB 的文本、超过 20 MB 的图片时页面上给一句说明；
 *      正看着的文件被改（脚本直接改会话目录里的文件，见下）以后，这一列不用重新点链接就换成
 *      新内容，而读到哪儿还停在哪儿；文件没变的那几轮里，正文一个字节都不再传一遍；
 *      点图片链接直接在这一列里看到那张图（2 MB 以上、20 MB 以内的也直接看，再大的给下载）；
 *      目录清单里图片那一行挂它自己的小图（只给 2 MB 以内的，免得一个目录里几十张大图一口气拉下来）；点二进制文件给一句「这是个二进制文件」加一个下载；
 *      点超过 2 MB 的文件给「太大，点这里下载」，正文一个字节都不塞进页面；点那个下载
 *      浏览器真把文件存了下来；点目录链接（以斜杠结尾的写法）切到「目录」那一格看到里面有什么，
 *      再一层层点进去（子目录接着列、文件点开看），列出来的东西一样受「只在会话目录内」的限制
 *      （指到目录外的条目点不了）；
 *      认得的几种语言（TypeScript 含 JavaScript 与 JSON、C++、Python，别名一起算）按扩展名带颜色，
 *      行号还在、跟内容对得上，跨多行的注释 / 模板串不会在行号那儿断开；别的语言仍是黑白；
 *      超过上色那条线的大文件不上色（行号照旧），也不把页面卡住；
 *      工具卡片（write）那颗「跳转」跟正文里的文件链接去同一个地方：浏览器页面里开左边这一列
 *      （自己滑出来、停在第一行），插件里的对话面板里还是交给编辑器打开（最后那段按网页视图验）；
 *      这一列角上那颗折行开关：默认一行就是一行（长行横向滚），点一下长行折起来（横向不滚），
 *      再点一下又回去；开关管的是整块正文（换个文件也照样）；选的那个记在这台设备里，
 *      刷新页面后还是刚才那样；
 *   2. 在页面里用 fetch 直接打那条只读文件地址与目录地址，核对拒绝的几种情形（目录外含 .. 绕出去的写法、
 *      没有这个文件 / 目录、超过文本那道 2 MB 线、超过图片那道 20 MB 线）、图片与二进制各自给什么、
 *      目录清单的形状（文件带着字节数、图片带着 image 标记）、以及「没变就别再给
 *      一遍正文」那条条件请求；下载那条路不受 2 MB 这条线管（几 MB 的文件整份下来）。
 * 最后一件事：把页面按“插件里的对话面板”跑一遍（在页面脚本里先塞一个网页视图接口），
 * 核对那边既没有这一列也没有这颗按钮、点链接照旧是交给编辑器打开那条消息。
 *
 * 测试用的文件（long.js / sample.js / big.txt）现写进会话目录（dev/.scratch），
 * 那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");

const LONG_LINES = 400;
const HIT_LINE = 137;
/** 第二次点 long.js 时链接说的那一行（换成另一行：切回原来那个标签、按这次的行滚）。 */
const HIT_LINE_AGAIN = 260;
const SAMPLE_HIT = 3;
/** 折行开关那一摊：wrap.js 第 2 行是一整条超长的行（一个断点都没有），专门看折还是横向滚。 */
const WRAP_LINES = 3;
const WRAP_HIT = 2;
const WRAP_LONG_CHARS = 400;
/** 比 2 MB 大出好几 MB：只用来验「太大」和「下载整份下来」，不当正文读。 */
const BIG_BYTES = 4 * 1024 * 1024;
/** 二进制那个文件多大（点下载存下来时按它核对字节数）。 */
const BINARY_BYTES = 4096;
/** 示例图片的原始尺寸（makePng.js 写的）——这一列里显示出来要按比例缩，但认得出是它那张。 */
const IMAGE_W = 1600;
const IMAGE_H = 400;
/** 一张噪点 PNG 的尺寸：压缩不了，所以体积超过文本那道 2 MB 的线（验证图片自己那条上限）。 */
const BIG_IMAGE_W = 1100;
const BIG_IMAGE_H = 800;
/** 超过图片那道线（20 MB）的一团字节：只验「太大 + 下载」，不必是张真图。 */
const HUGE_IMAGE_BYTES = 21 * 1024 * 1024;
/**
 * 目录那一摊要验的东西：dirA 下面有子目录（sub）、空目录（empty）、指到会话目录外面的软链接（out）、
 * 两个文件；清单里子目录在前、文件在后，各自按名字排。
 */
const DIR = {
    top: "dirA",
    sub: "dirA/sub",
    empty: "dirA/empty",
    topFile: "dirA/one.js",
    topText: "dirA/two.txt",
    subFile: "dirA/sub/three.js",
    outLink: "dirA/out",
    huge: "dirB",
    /** 清单里挂缩略图的那张小图（跟会话目录里那张一样大）。 */
    thumbImage: "dirA/pic.png",
    /** 清单里那张超过 2 MB 的图：太大，不挂缩略图（点开照样能看）。 */
    bigImage: "dirA/big.png",
};
/** dirA 那层清单该有的顺序（子目录在前、文件在后）。 */
const DIR_TOP_NAMES = ["empty", "out", "sub", "big.png", "one.js", "pic.png", "two.txt"];
const DIR_ONE_LINES = 5;
const DIR_SUB_FILE_LINES = 7;
/** dirB 里铺这么多文件：比后端一份清单的上限（500）多出几个，验「只列一部分」。 */
const DIR_HUGE_FILES = 505;
const DIR_MAX_ENTRIES = 500;
/** live.js：这一列正看着它的时候脚本改它（验“跟着刷新”那个文件）。 */
const LIVE_LINES = 300;
const LIVE_HIT = 100;

/**
 * 上色那一摊：认得的几种（TypeScript 含 JavaScript 与 JSON、C++、Python）带颜色，其余黑白。
 * 每个小文件都铺成固定几行，里面故意放上跨多行的注释 / 模板串——整段高亮再按行拆开时，
 * 这种跨行的记号不许在行号那儿断掉。
 */
const COLOR = {
    ts: "color.ts",
    js: "color.js",
    json: "color.json",
    cpp: "color.cpp",
    py: "color.py",
    ruby: "color.rb",          // 不认得的一种（还是黑白）
    mid: "color-mid.ts",       // 上色那条线以内的中等文件（照样上色）
    big: "color-big.ts",       // 超过上色那条线的大文件（不上色、也不许把页面卡住）
};
const COLOR_TS_LINES = [
    'import { readFile } from "node:fs";',
    "",
    "export function add(a: number, b: number): number {",
    "  // 加法",
    '  const s = `sum=${a + b}`;',
    "  return a + b;",
    "}",
    "",
    "/* 块注释第一行",
    "   块注释第二行 */",
    "const multi = `第一行",
    "第二行`;",
];
const COLOR_JS_LINES = [
    '"use strict";',
    "",
    "const count = 3;",
    "function double(n) {",
    "  // 乘二",
    "  return n * 2;",
    "}",
];
const COLOR_JSON_LINES = [
    "{",
    '  "name": "pi",',
    '  "count": 42,',
    '  "ok": true,',
    '  "list": [1, 2, 3]',
    "}",
];
const COLOR_CPP_LINES = [
    "#include <string>",
    "",
    "int main() {",
    "  // 注释",
    '  std::string s = "hi";',
    "  /* 块注释第一行",
    "     块注释第二行 */",
    "  return 0;",
    "}",
];
const COLOR_PY_LINES = [
    "def add(a, b):",
    "    # 注释",
    '    s = f"x={a}"',
    "    return a + b",
    "",
    "print(add(1, 2))",
];
const COLOR_RUBY_LINES = [
    "def add(a, b)",
    "  # 注释",
    '  "x=#{a}"',
    "end",
    "",
    "puts add(1, 2)",
];
/** 中等 / 大文件铺成什么样：一个十行的单元重复写到够长（行数由 repeat 次数算出来，不另数）。 */
const COLOR_UNIT_LINES = 10;
const COLOR_UNIT = [
    "export interface Foo { name: string; value: number }  // 一条接口",
    "const x: number = 42 + Math.floor(Math.random() * 10);",
    "function bar<T>(items: T[], cb: (t: T) => void): void {",
    "  for (const it of items) { cb(it); }",
    "  // 注释",
    '  const s = `v=${x}`;',
    "}",
    "/* 块注释",
    "   还在注释里 */",
    "class Baz extends Foo<string> { run(): void {} }",
].join("\n") + "\n";
/** 铺到这么多字（“字”不是“字节”：上色那条线看的是字符个数，不是文件大小）。 */
function makeColorText(minChars) {
    let text = "";
    let lines = 0;
    while (text.length < minChars) { text += COLOR_UNIT; lines += COLOR_UNIT_LINES; }
    return { text: text, lines: lines };
}
const COLOR_MID = makeColorText(200 * 1024);
const COLOR_BIG = makeColorText(1500 * 1024);
/** 往消息流里投的那句话：上面这几个文件各点一次。 */
const COLOR_LINK_TEXT =
    "带颜色的几个文件：\n\n" +
    "`" + COLOR.ts + ":3`、`" + COLOR.js + ":3`、`" + COLOR.json + ":3`、\n" +
    "`" + COLOR.cpp + ":3`、`" + COLOR.py + ":1`、`" + COLOR.ruby + ":1`、\n" +
    "`" + COLOR.mid + ":3`、`" + COLOR.big + ":3`。\n";

/**
 * markdown 那一摊：排好版渲染成文档（标题、列表、代码块都要对），不留行号；
 * 链接里带的 `:12` 等于没带，也不报错。
 * 同样的记号写在一个扩展名不是 markdown 的文件里（markdown-notes.txt）就不算文档，照旧一行一行带行号。
 */
const MD = {
    doc: "readme-test.md",
    plain: "markdown-notes.txt",
    hit: 12,               // 链接里带的行号：markdown 不留行号，这个不生效
    h1: "项目说明",
    h2: "用法",
    items: ["第一项", "第二项", "第三项"],
    ordered: ["一号", "二号"],
    code: "const a = 1;",
    quote: "引用一句",
    link: "sample.js",    // 文档里写到的一个文件：点了开在这一列里（不是把页面卷走）
    linkLine: 2,
};
const MD_TEXT = [
    "# " + MD.h1,
    "",
    "这是一段正文，里面有行内代码 `inline()` 与**加粗**，还提到 " + MD.link + ":" + MD.linkLine + " 这个文件。",
    "",
    "- " + MD.items[0],
    "- " + MD.items[1],
    "- " + MD.items[2],
    "",
    "1. " + MD.ordered[0],
    "2. " + MD.ordered[1],
    "",
    "```js",
    MD.code,
    "console.log(a);",
    "```",
    "",
    "> " + MD.quote,
    "",
    "## " + MD.h2,
    "",
].join("\n") + "\n";
/** 同样的记号，扩展名不是 markdown：照旧一行一行显示、带行号（`#` 与围栏都只是普通文字）。 */
const MD_PLAIN_LINES = [
    "# 这行不是标题",
    "```js",
    MD.code,
    "```",
    "- 这行不是列表",
];
/**
 * 光名字那一摊：链接里只有 `only-name.js` 这种光名字、或者路径写岔了时，后端先按会话目录拼；
 * 拼不到，就在「这个会话碰过的文件」（read / edit / write 过的，后端有这份清单）里按文件名找；
 * 还没有，就在会话目录里按名字找一圈（不进 node_modules 这类目录，有定额）。
 * 素材：子目录里藏一个（光名字链接靠第二档找到它）、会话目录里与子目录里各放一个同名的
 *（先按会话目录拼那一档该赢）、会话目录外面那个 package.json（清单里匹配到了，边界也得挡住）、
 * 深浅两层同名的一个（会话里没人碰过，靠第三档找到浅的那一份）、以及藏在 node_modules 里那个
 *（第三档不进去，按找不到算）。
 * 这份清单来自 pi 的工具调用，所以下面先让假 pi 读这几个文件（见 fakePi.js 的「碰文件」那一段）。
 * 文件名字写成 ASCII：消息流里那条链接规则只认 `[\w@-]`，中文名字根本不会变链接。
 */
const NAME = {
    deepDir: "names",
    bare: "only-name.js",             // 链接里那个光名字（会话目录里没有、子目录里有）
    bareFile: "names/only-name.js",
    both: "two-places.js",            // 会话目录这一份（清单里没有它）
    bothDeep: "names/two-places.js",  // 子目录这一份（清单里有它）
    wrong: "nowhere/only-name.js",    // 路径写岔了：那个目录根本不存在
    outside: "package.json",         // 光名字匹配到清单里 outside/package.json（真身在外面）
    absent: "nobody-touched.js",      // 三档都找不到
    // 第三档（在会话目录里按名字找一圈）的两份素材：会话里没人碰过、只在子目录里；
    // 以及藏在 node_modules 里的那个（那一档不进去那些目录，该按找不到算）
    byName: "picked-by-name.js",
    byNameShallow: "deep/picked-by-name.js",
    byNameDeep: "deep/nested/picked-by-name.js",
    skipped: "skip-me.js",
    skippedFile: "node_modules/skip-me.js",
};
const NAME_LINES = [
    "// only-name 第 1 行",
    "// only-name 第 2 行",
    "// only-name 第 3 行",
    "// only-name 第 4 行（就停这一行）",
    "// only-name 第 5 行",
    "// only-name 第 6 行",
];
/** 第三档找到的那一份：深浅两层同名各一份，浅的那一层该赢。 */
const NAME_BY_NAME_LINES = ["// deep 里这一份 1", "// deep 里这一份 2"];
const NAME_BY_NAME_DEEP_LINES = ["// nested 里这一份 1", "// nested 里这一份 2"];
const NAME_SKIPPED_LINES = ["// 藏在 node_modules 里 1", "// 藏在 node_modules 里 2"];
const NAME_HIT = 4;
const NAME_BOTH_LINES = ["// 会话目录这一份 1", "// 会话目录这一份 2", "// 会话目录这一份 3"];
const NAME_BOTH_DEEP_LINES = [
    "// 子目录这一份 1",
    "// 子目录这一份 2",
    "// 子目录这一份 3",
    "// 子目录这一份 4",
    "// 子目录这一份 5",
];
/** 光名字那一段往消息流里投的链接。 */
const NAME_LINK_TEXT =
    "光名字那几个：\n\n" +
    "`" + NAME.bare + ":" + NAME_HIT + "`、`" + NAME.wrong + ":" + NAME_HIT + "`、" +
    "`" + NAME.both + ":1`、`" + NAME.outside + ":1`、`" + NAME.absent + ":1`、" +
    "`" + NAME.byName + ":1`、`" + NAME.skipped + ":1`。\n";

const FILE = {
    long: "long.js",
    sample: "sample.js",
    live: "live.js",
    wrap: "wrap.js",
    missing: "missing.txt",
    big: "big.txt",
    bigBinary: "big.bin",
    outside: "outside/package.json",
    image: "picture.png",
    /** 超过 2 MB 的一张真图：该直接显示（图片自己的上限是 20 MB）。 */
    bigImage: "big-picture.png",
    /** 超过 20 MB 的一张图：只验「太大 + 下载」。 */
    hugeImage: "huge-picture.png",
    binary: "data.bin",
};
/**
 * 工具卡片那颗「跳转」验的：一张 write 卡片（收成工具行里那颗小标签），点提示框里那颗「跳转」。
 * 条目写进消息流里、文件用的就是会话目录里现成的 sample.js（跟正文链接去同一个地方才算数）。
 */
const JUMP_FILE = "sample.js";
const JUMP_LINES = 5;
const JUMP_CARD_ID = "jump-card";
const JUMP_ARGS = {
    path: JUMP_FILE,
    content: "// sample 1\n// sample 2\n// sample 3 这一行\n// sample 4\n// sample 5\n",
};
const LINK_TEXT =
    "看这几个文件：\n\n" +
    "`" + FILE.long + ":" + HIT_LINE + "` 这一行、`" + FILE.sample + ":" + SAMPLE_HIT + "` 这一行，\n" +
    "`" + FILE.wrap + ":" + WRAP_HIT + "` 这个里面有一条超长的行，\n" +
    "`" + FILE.long + ":" + HIT_LINE_AGAIN + "` 这个文件再说一次，\n" +
    "`" + FILE.live + ":" + LIVE_HIT + "` 这个是拿着看的，\n" +
    "`" + FILE.image + ":1` 这个是张图、`" + FILE.bigImage + ":1` 这张超过 2 MB、`" + FILE.hugeImage + ":1` 这张超过 20 MB、\n" +
    "`" + FILE.binary + ":1` 这个是二进制的。\n" +
    "再试试 `" + FILE.missing + ":1`、`" + FILE.outside + ":1`、`" + FILE.big + ":1`、`" + FILE.bigBinary + ":1`。\n" +
    "\n还有目录：`" + DIR.top + "/` 这里面有什么、`" + DIR.sub + "/` 是它下面的子目录，\n" +
    "`" + DIR.empty + "/` 是个空目录、`outside/` 这个目录在会话目录外、`" + DIR.huge + "/` 这个目录里东西很多。\n" +
    "普通文字里的 " + DIR.top + "/ 也该能点；英文里的 and/or 不该当成路径。\n" +
    "\n还有两个：`" + MD.doc + ":" + MD.hit + "` 这个是 markdown 文档、`" + MD.plain + ":2` 这个不是。\n";

/** live.js 每次都整份重写：marker 为真就把第 LIVE_HIT 行换个说法（行数不变），extra 是末尾多加几行。 */
function writeLive(cwd, marker, extra) {
    const lines = [];
    for (let i = 1; i <= LIVE_LINES + (extra || 0); i++) {
        lines.push(i === LIVE_HIT && marker ? "// live 第 " + i + " 行（改过了）" : "// live 第 " + i + " 行");
    }
    fs.writeFileSync(path.join(cwd, FILE.live), lines.join("\n") + "\n", "utf8");
}

/**
 * 往会话目录里铺目录那一摊（每次跑都重写一遍）：一个两层的小树、一个空目录、
 * 以及一颗指到会话目录外面的软链接（它会被列进清单里，但点不了）。
 */
function prepareDirs(cwd) {
    fs.mkdirSync(path.join(cwd, DIR.sub), { recursive: true });
    fs.mkdirSync(path.join(cwd, DIR.empty), { recursive: true });
    const one = [];
    for (let i = 1; i <= DIR_ONE_LINES; i++) { one.push("// one 第 " + i + " 行"); }
    fs.writeFileSync(path.join(cwd, DIR.topFile), one.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, DIR.topText), "// two 1\n// two 2\n// two 3 这一行\n", "utf8");
    const three = [];
    for (let i = 1; i <= DIR_SUB_FILE_LINES; i++) { three.push("// three 第 " + i + " 行"); }
    fs.writeFileSync(path.join(cwd, DIR.subFile), three.join("\n") + "\n", "utf8");
    // 清单里的缩略图：一张小的（该挂）与一张超过 2 MB 的（不挂，免得一个目录里几十张大图全拉下来）
    try {
        require("./makePng.js").writeSamplePng(path.join(cwd, DIR.thumbImage), 320, 200);
        require("./makePng.js").writeSamplePng(path.join(cwd, DIR.bigImage), BIG_IMAGE_W, BIG_IMAGE_H, true);
    } catch { /* 生成不了就少验一条 */ }
    const link = path.join(cwd, DIR.outLink);
    if (!fs.existsSync(link)) {
        try { fs.symlinkSync(path.resolve(__dirname, ".."), link, "junction"); } catch { /* 建不了就少验一条 */ }
    }
    // 东西太多的目录：比一份清单的上限多几个（几百上千项全画进这一列会把页面卡死）
    const huge = path.join(cwd, DIR.huge);
    fs.mkdirSync(huge, { recursive: true });
    for (let i = 0; i < DIR_HUGE_FILES; i++) {
        const name = "f" + String(i).padStart(3, "0") + ".txt";
        if (!fs.existsSync(path.join(huge, name))) { fs.writeFileSync(path.join(huge, name), "// " + name + "\n", "utf8"); }
    }
}

/**
 * 光名字那一摊的素材（每次跑都重写一遍）：子目录里藏一个光名字、会话目录里与子目录里各放一个
 * 同名的。会话目录外面那个文件就是 prepareFiles 里那颗 outside 软链接里头的 package.json，
 * 不用另外铺。
 */
function prepareNameFixtures(cwd) {
    fs.mkdirSync(path.join(cwd, NAME.deepDir), { recursive: true });
    fs.writeFileSync(path.join(cwd, NAME.bareFile), NAME_LINES.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, NAME.both), NAME_BOTH_LINES.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, NAME.bothDeep), NAME_BOTH_DEEP_LINES.join("\n") + "\n", "utf8");
    // 第三档那两份：深浅两层同名（浅的那一层该赢），以及藏在 node_modules 里的（那一档不进去）
    fs.mkdirSync(path.join(cwd, "deep", "nested"), { recursive: true });
    fs.writeFileSync(path.join(cwd, NAME.byNameShallow), NAME_BY_NAME_LINES.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, NAME.byNameDeep), NAME_BY_NAME_DEEP_LINES.join("\n") + "\n", "utf8");
    fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(cwd, NAME.skippedFile), NAME_SKIPPED_LINES.join("\n") + "\n", "utf8");
}

/** 往会话目录里造测试用的文件（每次跑都重写一遍，内容与行数固定）。 */
function prepareFiles(cwd) {
    const long = [];
    for (let i = 1; i <= LONG_LINES; i++) { long.push("// 第 " + i + " 行"); }
    fs.writeFileSync(path.join(cwd, FILE.long), long.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, FILE.sample),
        "// sample 1\n// sample 2\n// sample 3 这一行\n// sample 4\n// sample 5\n", "utf8");
    writeLive(cwd, false, 0);
    // 折行开关那一摊：第 2 行是一整条 400 个字、一个断点都没有的长行
    fs.writeFileSync(path.join(cwd, FILE.wrap),
        ["// wrap 1", "// " + "x".repeat(WRAP_LONG_CHARS) + " 超长的一行", "// wrap 3"].join("\n") + "\n", "utf8");
    prepareNameFixtures(cwd);
    fs.writeFileSync(path.join(cwd, FILE.big), Buffer.alloc(BIG_BYTES, 0x78));
    fs.copyFileSync(path.join(cwd, FILE.big), path.join(cwd, FILE.bigBinary));   // 同样大，但是个二进制扩展名
    // 一张真图（尺寸固定）与一个真二进制（有 0 字节、有高位字节，当文字读不出来）
    try { require("./makePng.js").writeSamplePng(path.join(cwd, FILE.image), IMAGE_W, IMAGE_H); } catch { /* 生成不了就少验一条 */ }
    // 一张真的大图（噪点压不动，2 MB 以上）与一团超过图片上限的字节（后者不当真图解码）
    try {
        require("./makePng.js").writeSamplePng(path.join(cwd, FILE.bigImage), BIG_IMAGE_W, BIG_IMAGE_H, true);
    } catch { /* 生成不了就少验一条 */ }
    fs.writeFileSync(path.join(cwd, FILE.hugeImage), Buffer.alloc(HUGE_IMAGE_BYTES, 0x89));
    const binary = Buffer.alloc(BINARY_BYTES);
    for (let i = 0; i < binary.length; i++) { binary[i] = (i * 37 + 200) % 256; }
    binary[0] = 0;   // 开头就是 0 字节：文本那套肯定读不了
    fs.writeFileSync(path.join(cwd, FILE.binary), binary);
    prepareDirs(cwd);
    prepareColorFiles(cwd);
    prepareMarkdownFiles(cwd);
    const outside = path.join(cwd, "outside");
    if (fs.existsSync(outside)) { return "已经有了"; }
    // 目录外那份用一个目录软链接（Windows 上 junction 不需要管理员权限）指到仓库根上：
    // 这样“路径字符串看着在目录里、真实路径在目录外”那条边界才有东西可验。
    try {
        fs.symlinkSync(path.resolve(__dirname, ".."), outside, "junction");
        return "建好了";
    } catch (err) {
        return "建不了（" + (err && err.message ? err.message : String(err)) + "）";
    }
}

/** markdown 那两个文件：一个是文档（该排好版渲染），一个扩展名不是 markdown（该照旧带行号）。 */
function prepareMarkdownFiles(cwd) {
    fs.writeFileSync(path.join(cwd, MD.doc), MD_TEXT, "utf8");
    fs.writeFileSync(path.join(cwd, MD.plain), MD_PLAIN_LINES.join("\n") + "\n", "utf8");
}

/** 上色那几个文件：认得的几种各一个小文件、一个不认得的、一个中等大小、一个超大。 */
function prepareColorFiles(cwd) {
    const write = (name, lines) => fs.writeFileSync(path.join(cwd, name), lines.join("\n") + "\n", "utf8");
    write(COLOR.ts, COLOR_TS_LINES);
    write(COLOR.js, COLOR_JS_LINES);
    write(COLOR.json, COLOR_JSON_LINES);
    write(COLOR.cpp, COLOR_CPP_LINES);
    write(COLOR.py, COLOR_PY_LINES);
    write(COLOR.ruby, COLOR_RUBY_LINES);
    fs.writeFileSync(path.join(cwd, COLOR.mid), COLOR_MID.text, "utf8");
    fs.writeFileSync(path.join(cwd, COLOR.big), COLOR_BIG.text, "utf8");
}

/** 页面上把假消息投进去（同一份内容刷新之后要再投一次）。 */
const POST_LINKS = `for (const m of ${JSON.stringify([{ type: "assistantFull", text: LINK_TEXT }])}) { window.postMessage(m, "*"); } return true;`;

/**
 * 宽度那一摊：没拖过是 360；拖起来夹在 300～1200 之间，常驻时还要跟「窗口宽度 − 360」取小。
 * 为什么是这几个数：再窄放不下一行代码，再宽对话那边就没地方了；手机上铺满是因为那一列
 * 在窄屏上本来就是整屏滑入的抽屉。
 */
const FILE_W_DEFAULT = 360;
const FILE_W_MIN = 300;
const FILE_W_MAX = 1200;
const FILE_W_RESERVE = 360;
/** 拖出来的宽度记在本机里的哪个键（跟界面里写的是同一个）。 */
const FILE_W_KEY = "pichat.fileSidebarWidth";
/** 这个窗口宽度下最多能拖多宽（常驻时那个上限）。 */
const fileWCap = (vw) => Math.max(FILE_W_MIN, Math.min(FILE_W_MAX, vw - FILE_W_RESERVE));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个文件在下载目录里出现（浏览器存盘是异步的：先落 .crdownload，改好名才算完）。 */
async function waitForFile(file, timeoutMs) {
    const limit = timeoutMs || 8000;
    const started = Date.now();
    while (Date.now() - started < limit) {
        if (fs.existsSync(file)) {
            const size = fs.statSync(file).size;
            await sleep(200);
            if (fs.existsSync(file) && fs.statSync(file).size === size && size > 0) { return file; }
        }
        await sleep(200);
    }
    return "";
}

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };

    // 每个标签各留自己那一块正文（切走只是藏起来，见 chat.js 的 fileTabPage）：
    // 正文里的东西一律从「露着的那一块」查，别从整个 #fileBody 查——
    // 那儿同时躺着别的标签的内容（藏起来的），全局查会读到人家的。
    const FILE_VIEW_SOURCE = `
        window.__fileView = function () {
            return document.querySelector("#fileBody .file-page:not([hidden])")
                || document.getElementById("fileBody");
        };
    `;
    let fileViewEverywhere = false;
    const installFileView = async () => {
        if (!fileViewEverywhere) {
            // 挂成「每份新文档都先跑一遍」：刷新之后页面是新的，一次性 eval 装进去的东西全没了
            //（这套脚本中途要刷新好几次，不这么挂就得每刷一次手动补一次，漏一处就是一句 TypeError）
            fileViewEverywhere = true;
            await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FILE_VIEW_SOURCE });
        }
        await page.eval(FILE_VIEW_SOURCE + " return true;");
    };

    await page.waitReady();
    await page.sleep(500);
    await installFileView();

    // 会话目录（顶条上那行小字）与会话标识（轮到自己看的那个会话）
    const sessionInfo = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({
            cwd: (((document.getElementById("sessionName") || {}).dataset || {}).cwd) || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "",
        });
    `));
    console.log("会话：" + JSON.stringify(sessionInfo));
    check("页面上说得出会话跑在哪个目录", sessionInfo.cwd !== "" && sessionInfo.sessionId !== "");

    const cwd = sessionInfo.cwd || require("./harness.js").SCRATCH_DIR;
    const made = prepareFiles(cwd);
    console.log("测试文件写进 " + cwd + "（目录外那个软链接：" + made + "）");

    // ==================== 宽窗：这一列常驻在左边 ====================
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);

    const LOOK = `
        const f = function () {
            const root = document.getElementById("fileSidebar");
            const box = document.getElementById("fileBody");   // 滚动那一格（量滚动位置、可见范围）
            const body = window.__fileView();                  // 正看着的那一块正文（内容从这儿查）
            const rows = body ? Array.from(body.querySelectorAll(".file-line")) : [];
            const hit = rows.find(function (r) { return r.classList.contains("hit"); });
            const bodyRect = body ? body.getBoundingClientRect() : null;
            const hitRect = hit ? hit.getBoundingClientRect() : null;
            const rootRect = root && getComputedStyle(root).display !== "none" ? root.getBoundingClientRect() : null;
            const chat = document.getElementById("chatColumn").getBoundingClientRect();
            const btn = document.getElementById("fileSidebarBtn");
            const backdrop = document.getElementById("fileBackdrop");
            const note = body ? body.querySelector(".file-note") : null;
            const dl = body ? body.querySelector("a.file-download") : null;
            const img = body ? body.querySelector(".file-image img") : null;
            const imgRect = img ? img.getBoundingClientRect() : null;
            // 目录清单里图片那一行的缩略图（别把整页里消息流的图算进来：只看清单里那几行）
            const thumbs = body ? Array.from(body.querySelectorAll(".file-entry .file-entry-icon img")) : [];
            const up = body ? body.querySelector(".file-entry.up") : null;
            const panelEl = document.getElementById("filePanel");
            const panelRect = panelEl ? panelEl.getBoundingClientRect() : null;
            const upRect = up ? up.getBoundingClientRect() : null;
            const closeEl = document.getElementById("fileClose");
            const closeRect = closeEl ? closeEl.getBoundingClientRect() : null;
            const pointAtId = function (x) {
                const el = document.elementFromPoint(x, 400);
                const named = el && el.closest ? el.closest("[id]") : null;
                return named ? named.id : "";
            };
            const insidePanel = function (r) {
                return !!r && !!panelRect && r.left >= panelRect.left - 1 && r.right <= panelRect.right + 1;
            };
            const bar = document.getElementById("fileTabs");
            const allTabs = bar ? Array.from(bar.querySelectorAll(".file-tab")) : [];
            // 下面那些 tabCount / tabPaths / tabActive 说的是「目录与文件」那些标签：
            // 常驻的「改动」那一格不算在里面（它有自己的改动贴一篇验，见 dev/changesTab.js）
            const tabs = allTabs.filter(function (t) { return t.getAttribute("data-changes") !== "1"; });
            const changesTab = allTabs.filter(function (t) { return t.getAttribute("data-changes") === "1"; })[0] || null;
            const entries = body ? Array.from(body.querySelectorAll(".file-entry:not(.up)")) : [];
            const wrapBtn = document.getElementById("fileWrap");
            const wrapRect = wrapBtn && getComputedStyle(wrapBtn).display !== "none" ? wrapBtn.getBoundingClientRect() : null;
            const textEl = body ? body.querySelector(".file-text") : null;
            return {
                vw: window.innerWidth,
                hasPanel: !!root,
                hasButton: !!btn,
                buttonAtBarLeft: !!btn && !!btn.parentElement && btn.parentElement.id === "sessionBar"
                    && btn.parentElement.firstElementChild === btn,
                panelShown: !!rootRect,
                panelLeft: rootRect ? Math.round(rootRect.left) : -1,
                panelWidth: rootRect ? Math.round(rootRect.width) : -1,
                resizeShown: !!(document.getElementById("fileResize")
                    && getComputedStyle(document.getElementById("fileResize")).display !== "none"),
                resizeAtEdge: (function () {
                    const z = document.getElementById("fileResize");
                    const r = z && getComputedStyle(z).display !== "none" ? z.getBoundingClientRect() : null;
                    return !!r && !!panelRect && Math.abs((r.left + r.right) / 2 - panelRect.right) <= 1;
                })(),
                // 拖拽热区那条竖带往右探进了对话那边多少（要跟输入框留出空当：那 6px 只该落在内边距上）
                resizeRight: (function () {
                    const z = document.getElementById("fileResize");
                    const r = z && getComputedStyle(z).display !== "none" ? z.getBoundingClientRect() : null;
                    const row = document.getElementById("inputRow");
                    const rr = row ? row.getBoundingClientRect() : null;
                    return (r && rr) ? Math.round(r.right - rr.left) : null;
                })(),
                full: document.body.classList.contains("file-full"),
                touch: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
                fileVar: getComputedStyle(document.documentElement).getPropertyValue("--pichat-file-sidebar-w").trim(),
                storedW: localStorage.getItem("pichat.fileSidebarWidth"),
                dock: document.body.classList.contains("file-dock"),
                open: document.body.classList.contains("file-open"),
                hidden: document.hidden,
                chatLeft: Math.round(chat.left),
                // 这一列头上不写路径了：最上面那一行就是标签条（叉钉在它右端），
                // 「目录」那一格现在在哪一层只看它的悬停提示（见下面的 tabTitles / projIndex）
                headPathShown: !!document.getElementById("fileTitle"),
                headerHasTabs: !!bar && bar.parentElement === document.getElementById("fileHeader"),
                tabsAtTop: !!bar && !!panelRect && bar.getBoundingClientRect().top <= panelRect.top + 2,
                tabsAboveBody: !!bar && !!box && bar.getBoundingClientRect().bottom <= box.getBoundingClientRect().top + 1,
                activePath: (function () {
                    const t = tabs.filter(function (x) { return x.classList.contains("active"); })[0];
                    return t ? (t.getAttribute("data-path") || "") : "";
                })(),
                upShown: !!up,
                upInHeader: !!up && !!up.closest("#fileHeader"),
                upFirstRow: !!up && !!body && body.firstElementChild === up,
                upText: up ? (up.innerText || "") : "",
                upInside: insidePanel(upRect),
                closeInside: insidePanel(closeRect),
                // 面板头上那几颗方形的「面板按钮」（现在只该有一颗「收起」）
                headerBtnCount: document.querySelectorAll("#fileHeader .pk-header-close").length,
                note: note ? (note.textContent || "") : "",
                downloadCount: body ? body.querySelectorAll("a.file-download").length : 0,
                downloadText: dl ? (dl.textContent || "") : "",
                downloadHref: dl ? (dl.getAttribute("href") || "") : "",
                downloadName: dl ? (dl.getAttribute("download") || "") : "",
                imgCount: body ? body.querySelectorAll(".file-image img").length : 0,
                imgNatural: img ? [img.naturalWidth, img.naturalHeight] : [0, 0],
                imgShown: imgRect ? { w: Math.round(imgRect.width), h: Math.round(imgRect.height) } : null,
                imgBroken: img ? (img.complete && img.naturalWidth === 0) : false,
                bodyChars: body ? (body.textContent || "").length : -1,
                rowCount: rows.length,
                // markdown 渲染出来的那份文档有几块、行号格子有几个（markdown 该是 0 / 0）
                mdCount: body ? body.querySelectorAll(".file-md").length : -1,
                numCount: body ? body.querySelectorAll(".file-num").length : -1,
                firstRow: rows.length ? rows[0].innerText : "",
                hitText: hit ? hit.innerText : "",
                hitNum: hit ? ((hit.querySelector(".file-num") || {}).textContent || "") : "",
                hitVisible: !!(hitRect && bodyRect
                    && hitRect.top >= bodyRect.top - 1 && hitRect.bottom <= bodyRect.bottom + 1),
                tabShown: !!bar && getComputedStyle(bar).display !== "none" && bar.getBoundingClientRect().height > 0,
                tabHeights: tabs.map(function (t) { return Math.round(t.getBoundingClientRect().height); }),
                tabCount: tabs.length,
                tabNames: tabs.map(function (t) { return (t.querySelector(".file-tab-name") || {}).textContent || ""; }),
                tabPaths: tabs.map(function (t) { return t.getAttribute("data-path") || ""; }),
                tabTitles: tabs.map(function (t) { return t.getAttribute("title") || ""; }),
                projIndex: tabs.findIndex(function (t) { return t.getAttribute("data-proj") === "1"; }),
                projCount: tabs.filter(function (t) { return t.getAttribute("data-proj") === "1"; }).length,
                projClose: tabs.some(function (t) { return t.getAttribute("data-proj") === "1" && !!t.querySelector(".file-tab-close"); }),
                tabActive: tabs.findIndex(function (t) { return t.classList.contains("active"); }),
                tabCloseCount: tabs.filter(function (t) { return !!t.querySelector(".file-tab-close"); }).length,
                // 常驻的「改动」那一格：在不在这里、排第几个（整条标签条上的位置）、有没有那颗叉
                allNames: allTabs.map(function (t) { return (t.querySelector(".file-tab-name") || {}).textContent || ""; }),
                changesIndex: allTabs.findIndex(function (t) { return t.getAttribute("data-changes") === "1"; }),
                changesCount: changesTab ? 1 : 0,
                changesClose: !!changesTab && !!changesTab.querySelector(".file-tab-close"),
                entryCount: entries.length,
                entryNames: entries.map(function (e) { return (e.querySelector(".file-entry-name") || {}).textContent || ""; }),
                entryDirs: entries.map(function (e) { return e.classList.contains("dir"); }),
                entryPaths: entries.map(function (e) { return e.getAttribute("data-path") || ""; }),
                thumbCount: thumbs.length,
                thumbLoaded: thumbs.filter(function (i) { return i.complete && i.naturalWidth > 0; }).length,
                thumbPaths: thumbs.map(function (i) {
                    const row = i.closest ? i.closest(".file-entry") : null;
                    return row ? (row.getAttribute("data-path") || "") : "";
                }),
                backdropShown: !!backdrop && getComputedStyle(backdrop).display !== "none",
                bodyTop: box ? Math.round(box.scrollTop) : -1,
                bodyMax: box ? Math.round(box.scrollHeight - box.clientHeight) : -1,
                barBottom: Math.round(document.getElementById("sessionBar").getBoundingClientRect().bottom),
                fileHeaderBottom: document.getElementById("fileHeader")
                    ? Math.round(document.getElementById("fileHeader").getBoundingClientRect().bottom) : -1,
                dockHeaderBottom: document.getElementById("dockHeader")
                    ? Math.round(document.getElementById("dockHeader").getBoundingClientRect().bottom) : -1,
                // 这一点上最上面的是谁：正文那几块自己没 id（见 chat.js 的 fileTabPage），
                // 所以往上找最近那个带 id 的（通常是 #fileBody、遮罩、或者这一列本身）
                topAtChat: pointAtId(Math.round(window.innerWidth * 0.5)),
                topAtRight: pointAtId(Math.round(window.innerWidth - 40)),
                wrapButton: !!wrapBtn,
                wrapShown: !!wrapRect,
                wrapInPanel: !!wrapBtn && !!panelEl && panelEl.contains(wrapBtn),
                wrapInHeader: !!wrapBtn && !!document.getElementById("fileHeader")
                    && document.getElementById("fileHeader").contains(wrapBtn),
                wrapInTabs: !!wrapBtn && !!bar && bar.contains(wrapBtn),
                wrapTop: wrapRect ? Math.round(wrapRect.top) : -1,
                wrapAtCorner: !!(wrapRect && panelRect)
                    && panelRect.right - wrapRect.right >= 0 && panelRect.right - wrapRect.right <= 24
                    && panelRect.bottom - wrapRect.bottom >= 0 && panelRect.bottom - wrapRect.bottom <= 24,
                wrapPressed: wrapBtn ? (wrapBtn.getAttribute("aria-pressed") || "") : "",
                wrapOnClass: !!wrapBtn && wrapBtn.classList.contains("on"),
                whiteSpace: textEl ? getComputedStyle(textEl).whiteSpace : "",
                hScroll: box ? Math.round(box.scrollWidth - box.clientWidth) : -1,
                headRowHeights: rows.slice(0, 4).map(function (r) { return Math.round(r.getBoundingClientRect().height); }),
                headRowLens: rows.slice(0, 4).map(function (r) {
                    return ((r.querySelector(".file-text") || {}).textContent || "").length;
                }),
            };
        };
        return JSON.stringify(f());
    `;
    const look = async (label) => {
        const r = JSON.parse(await page.eval(LOOK));
        const s = JSON.stringify(r);
        // 目录里几百项时这一行会长到没法读：截一下，反正下面每一条都自己说结论
        console.log(label + "：" + (s.length > 900 ? s.slice(0, 900) + "…（太长，后面截了）" : s));
        return r;
    };
    /** 等这一列变成想要的样子（换内容、换成一句提示都是异步来的）：cond 拿一次读数判断行不行。 */
    const waitLook = async (what, cond, timeoutMs) => {
        const limit = timeoutMs || 8000;
        const started = Date.now();
        let got = null;
        while (Date.now() - started < limit) {
            got = JSON.parse(await page.eval(LOOK));
            if (cond(got)) { return got; }
            await page.sleep(250);
        }
        console.log("（等超时：" + what + "，现在这样：" + JSON.stringify(got) + "）");
        return got;
    };
    /** 装上探针：记下每一条打 /file 的请求（带没带修改时间、回什么状态、正文几字节）。 */
    const PROBE = `
        window.__fileProbe = window.__fileProbe || [];
        if (!window.__fileProbeOn) {
            window.__fileProbeOn = true;
            const realFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
                const url = typeof input === "string" ? input : String((input && input.url) || "");
                const p = realFetch(input, init);
                if (url.indexOf("/file?") >= 0) {
                    const rec = { mtime: url.indexOf("mtime=") >= 0, status: 0, bytes: 0 };
                    window.__fileProbe.push(rec);
                    p.then(function (resp) { rec.status = resp.status; return resp.clone().text(); })
                        .then(function (text) { rec.bytes = text.length; })
                        .catch(function () { /* 这条请求塌了，不影响页面 */ });
                }
                return p;
            };
        }
        return true;
    `;
    /** 点消息流里某个文件的链接。给了 line 就挑说的那一行那一个（同一个文件可能有好几个链接）。 */
    const clickLink = (file, line) => page.eval(`
        const want = { file: ${JSON.stringify(file)}, line: ${line === undefined ? "null" : JSON.stringify(String(line))} };
        const a = Array.from(document.querySelectorAll("a.file-link")).find(function (x) {
            return x.getAttribute("data-file") === want.file
                && (want.line === null || x.getAttribute("data-line") === want.line);
        });
        if (!a) { return "没有这个链接"; }
        a.click();
        return "点了";
    `);
    /** 点消息流里某个目录的链接（以斜杠结尾的那种）。传的路径不带末尾的斜杠。 */
    const clickDir = (dir) => page.eval(`
        const want = ${JSON.stringify(dir)};
        const a = Array.from(document.querySelectorAll("a.file-link")).find(function (x) {
            if (x.getAttribute("data-dir") !== "1") { return false; }
            const p = x.getAttribute("data-file") || "";
            return p === want || p === want + "/";
        });
        if (!a) { return "没有这个目录链接"; }
        a.click();
        return "点了";
    `);
    /** 点这一列里那份清单里的一项（按它给的相对路径找）。 */
    const clickEntry = (entryPath) => page.eval(`
        const r = Array.from(window.__fileView().querySelectorAll(".file-entry"))
            .find(function (x) { return x.getAttribute("data-path") === ${JSON.stringify(entryPath)}; });
        if (!r) { return "清单里没有这一项"; }
        r.click();
        return "点了";
    `);
    /** 「目录」那一格在界面上该叫什么、悬停提示该给什么（没有那一格就空串）。 */
    const projName = (r) => (r.projIndex >= 0 ? r.tabNames[r.projIndex] : "");
    const projTitle = (r) => (r.projIndex >= 0 ? r.tabTitles[r.projIndex] : "");
    /** 两个路径是不是同一个地方（斜杠方向、末尾斜杠、大小写都归一化再比）。 */
    const samePathText = (a, b) => String(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
        === String(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    /** 正看着的那一格是哪个文件（「目录」「改动」这两格没有文件：给空串）。 */
    const activeFilePath = (r) => r.activePath;
    /** 这一列头上不写路径了：最上面那一行就是标签条（叉钉在它右端）。
        「目录」那一格现在在哪一层，只看它的悬停提示（给这一层的全路径）。 */
    const headOk = (r, base, inside) => r.headPathShown === false && r.headerHasTabs
        && r.tabsAtTop && r.tabsAboveBody
        && samePathText(projTitle(r), path.join(base, inside || ""));
    /** 点清单第一行那颗「上一层」。 */
    const clickUp = () => page.eval(`
        const b = window.__fileView().querySelector(".file-entry.up");
        if (!b) { return "清单里没有「上一层」这一行"; }
        b.click();
        return "点了";
    `);
    /** 点「目录」那一格（切换过去看它那份清单）。 */
    const clickProjTab = () => page.eval(`
        const t = document.querySelector("#fileTabs .file-tab[data-proj='1']");
        if (!t) { return "没有目录那个标签"; }
        t.click();
        return "点了";
    `);
    /** 点某一个标签（按标签说的文件找）、或者点它那颗叉。 */
    const clickTab = (file, what) => page.eval(`
        const tabs = Array.from(document.querySelectorAll("#fileTabs .file-tab"));
        const t = tabs.find(function (x) { return x.getAttribute("data-path") === ${JSON.stringify(file)}; });
        if (!t) { return "没有这个标签"; }
        const el = ${JSON.stringify(what)} === "close" ? t.querySelector(".file-tab-close") : t;
        if (!el) { return "标签上没有这个东西"; }
        el.click();
        return "点了";
    `);
    /** write 卡片那颗小标签：把它的提示框弄出来（电脑上悬浮、触屏上点一下，两种都发一下动作）。 */
    const showJumpTip = () => page.eval(`
        const pill = Array.from(document.querySelectorAll("#messages .tool-group"))
            .find(function (p) { const n = p.querySelector(".tg-name"); return n && n.textContent.trim() === "write"; });
        if (!pill) { return "没有 write 那个标签"; }
        pill.dispatchEvent(new MouseEvent("mouseenter"));
        pill.click();
        return "把提示框弄出来了";
    `);
    /** 等提示框里那颗「跳转」画出来（电脑上悬浮 200ms 后才画），顺手把它那句悬停说明读回来。 */
    const waitJumpBtn = async () => {
        const started = Date.now();
        let got = { found: false, title: "" };
        while (Date.now() - started < 5000) {
            got = JSON.parse(await page.eval(`
                const b = document.querySelector(".tag-tip .et-jump");
                return JSON.stringify({ found: !!b, title: b ? (b.getAttribute("title") || "") : "" });
            `));
            if (got.found) { return got; }
            await page.sleep(150);
        }
        return got;
    };
    /** 点提示框里那颗「跳转」。 */
    const clickJumpBtn = () => page.eval(`
        const b = document.querySelector(".tag-tip .et-jump");
        if (!b) { return "没有那颗跳转按钮"; }
        b.click();
        return "点了";
    `);

    /** 右边那条缝现在什么颜色：不在指针下时该是透明的（热区本身看不见），指针移上去该亮起来。 */
    const edgeLine = () => page.eval(`
        const z = document.getElementById("fileResize");
        return z ? getComputedStyle(z, "::before").backgroundColor : "";
    `);

    /** 点这一列角上那颗折行开关。 */
    const clickWrap = () => page.eval(`
        const b = document.getElementById("fileWrap");
        if (!b) { return "没有折行开关"; }
        b.click();
        return "点了";
    `);

    /**
     * 拖右边那条缝（真按真拖：pointerdown → 六段 pointermove → pointerup）。
     * 中途先读一次这一列的宽度：读到的跟要拖到的地方一样，就说明是拖着就在变、不是松手才变。
     * 滑入式里那条缝是不显示的，这些事件发上去也该没反应（那时宽读出来就是原来的数）。
     */
    const dragEdge = (fromX, toX) => page.eval(`
        const h = document.getElementById("fileResize");
        if (!h) { return JSON.stringify({ gone: true }); }
        const mk = function (type, x, buttons) {
            return new PointerEvent(type, { bubbles: true, cancelable: true,
                pointerId: 1, pointerType: "mouse", button: 0, buttons: buttons, clientX: x, clientY: 400 });
        };
        const root = document.getElementById("fileSidebar");
        const chat = document.getElementById("chatColumn");
        h.dispatchEvent(mk("pointerdown", ${fromX}, 1));
        for (let i = 1; i <= 6; i++) {
            window.dispatchEvent(mk("pointermove", ${fromX} + (${toX} - ${fromX}) * i / 6, 1));
        }
        const midWidth = Math.round(root.getBoundingClientRect().width);
        const midChatLeft = Math.round(chat.getBoundingClientRect().left);
        const midClass = document.body.classList.contains("file-resizing");
        window.dispatchEvent(mk("pointerup", ${toX}, 0));
        return JSON.stringify({
            midWidth: midWidth, midChatLeft: midChatLeft, midClass: midClass,
            afterWidth: Math.round(root.getBoundingClientRect().width),
            afterClass: document.body.classList.contains("file-resizing"),
            chatLeft: Math.round(chat.getBoundingClientRect().left),
            stored: localStorage.getItem(${JSON.stringify(FILE_W_KEY)}),
        });
    `);

    await page.eval(POST_LINKS);
    await page.sleep(400);
    const linkCount = await page.eval(`return document.querySelectorAll("a.file-link").length`);
    check("消息流里出现了文件链接", linkCount >= 5, "共 " + linkCount + " 个");

    const wide0 = await look("宽窗 · 还没点任何链接");
    check("顶条左边有一颗文件侧边栏按钮", wide0.hasButton && wide0.buttonAtBarLeft);
    check("没点开时左边那一列不占地方", !wide0.open && !wide0.dock && wide0.chatLeft === 0);

    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    const wide1 = await look("宽窗 · 点顶条那颗按钮");
    check("点按钮开出来、并且在左边常驻", wide1.open && wide1.dock && wide1.panelLeft === 0 && wide1.panelWidth === FILE_W_DEFAULT);
    check("对话让出左边这块宽度", wide1.chatLeft === FILE_W_DEFAULT);
    check("面板头跟顶条的横线齐", wide1.fileHeaderBottom === wide1.barBottom && wide1.dockHeaderBottom === wide1.barBottom,
        JSON.stringify({ bar: wide1.barBottom, file: wide1.fileHeaderBottom, dock: wide1.dockHeaderBottom }));
    // 一个标签都没有的时候，第一个标签就是「目录」（当前会话的目录），而不是一句提示
    const wide1proj = await waitLook("目录那一格列出来", (x) => x.projCount === 1 && x.entryCount > 0);
    check("点按钮开出来：第一个标签就是「目录」", wide1proj.tabShown && wide1proj.projCount === 1 && wide1proj.projIndex === 0
        && projName(wide1proj) === "目录" && wide1proj.tabActive === 0,
        JSON.stringify({ names: wide1proj.tabNames, active: wide1proj.tabActive }));
    check("目录那一格列的是当前会话目录里的内容",
        wide1proj.entryCount > 0 && wide1proj.entryPaths.indexOf(FILE.long) >= 0
        && wide1proj.entryPaths.indexOf(DIR.top) >= 0 && wide1proj.rowCount === 0 && wide1proj.note === "",
        JSON.stringify(wide1proj.entryNames));
    check("那一格悬停给全路径（还在最外面那一层：会话目录本身），头上那一行就是标签条",
        projTitle(wide1proj) === cwd && headOk(wide1proj, cwd),
        JSON.stringify({ tab: projTitle(wide1proj), path: wide1proj.headPathShown }));
    check("全路径很长时那一行右端的「收起」也不被挤出这一列", wide1proj.closeInside, String(wide1proj.closeInside));
    check("那一行上只有一颗「收起」（「上一层」不在那儿）",
        wide1proj.headerBtnCount === 1, "头上 " + wide1proj.headerBtnCount + " 颗");
    check("「目录」那一格没有那颗叉（不让人关掉）", wide1proj.projClose === false && wide1proj.tabCloseCount === 0);
    // 「改动」那一格是常驻的（见 dev/changesTab.js 那个贴）：它固定在「目录」后面、同样没有那颗叉，
    // 下面的 tabCount / tabPaths / tabActive 只说「目录与文件」那几格，不算它
    check("标签条上常驻「改动」那一格（紧跟在「目录」后面、没有叉）",
        wide1proj.changesCount === 1 && wide1proj.changesIndex === 1 && wide1proj.changesClose === false
        && wide1proj.allNames[1] === "改动",
        JSON.stringify({ names: wide1proj.allNames, at: wide1proj.changesIndex }));
    await page.shot("file-1-project-dir.png");

    // 刷新：开没收起记在这台设备里
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await installFileView();
    await page.eval(POST_LINKS);
    await page.sleep(300);
    const wide2 = await look("宽窗 · 刷新之后");
    check("刷新之后还是开着（记在这台设备里）", wide2.open && wide2.dock && wide2.panelShown);
    const wide2b = await waitLook("刷新之后目录那一格又给出来", (x) => x.projCount === 1 && x.entryCount > 0);
    check("刷新之后第一个标签还是当前会话的目录（文件标签不恢复）",
        wide2b.tabCount === 1 && wide2b.projIndex === 0 && projName(wide2b) === "目录"
        && projTitle(wide2b) === cwd && wide2b.entryPaths.indexOf(FILE.long) >= 0,
        JSON.stringify({ count: wide2b.tabCount, title: projTitle(wide2b) }));

    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    const wide3 = await look("宽窗 · 再点一下那颗按钮");
    check("再点一下收起来、对话铺满", !wide3.open && !wide3.dock && wide3.chatLeft === 0);
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await installFileView();
    await page.eval(POST_LINKS);
    await page.sleep(300);
    const wide4 = await look("宽窗 · 收起之后刷新");
    check("收起之后刷新还是收起", !wide4.open && !wide4.dock);

    // 点文件链接：左边开出来、显示那个文件、停在链接说的那一行
    console.log("点文件链接：" + await clickLink(FILE.long));
    await page.sleep(600);
    const wide5 = await look("宽窗 · 点 long.js:" + HIT_LINE);
    check("点上链接左边开出来（不用先点按钮）", wide5.open && wide5.dock && wide5.panelLeft === 0);
    check("正看着的那一格是那个文件", activeFilePath(wide5) === FILE.long);
    check("内容带行号、行数对得上", wide5.rowCount === LONG_LINES && wide5.firstRow.indexOf("1") >= 0, wide5.firstRow);
    check("停在链接说的那一行并高亮", wide5.hitNum === String(HIT_LINE) && wide5.hitText.indexOf("第 " + HIT_LINE + " 行") >= 0 && wide5.hitVisible);
    check("文件开在「目录」后面那一格新标签里（原来那格没被顶掉）",
        wide5.tabShown && wide5.tabCount === 2 && wide5.projCount === 1 && wide5.projIndex === 0
        && projName(wide5) === "目录" && wide5.tabPaths[1] === FILE.long && wide5.tabActive === 1,
        JSON.stringify({ names: wide5.tabNames, active: wide5.tabActive }));
    // 标签铺满最上面那一行（见 chat.css 的 #fileHeader / #fileTabs）：一格不比另一格矮，
    // 只剩「目录」自己开着的时候也不缩成一薄条
    check("那一行的标签都一样高（格子少了也不缩成一薄条）",
        wide5.tabHeights.length === 2 && wide5.tabHeights[0] === wide5.tabHeights[1]
        && wide1proj.tabHeights.length === 1 && wide1proj.tabHeights[0] >= 28,
        JSON.stringify({ 只有目录: wide1proj.tabHeights, 跟文件一起: wide5.tabHeights }));
    check("两格标签里只有文件那格有叉（目录那格关不掉）",
        wide5.tabCloseCount === 1 && wide5.projClose === false);
    check("正文很长也不把面板头挤扁（跟顶条的横线还是齐的）", wide5.fileHeaderBottom === wide5.barBottom,
        JSON.stringify({ bar: wide5.barBottom, file: wide5.fileHeaderBottom }));
    await page.shot("file-2-line.png");

    // 再点另一个文件：新开一个标签，原来那个还留着
    console.log("点文件链接：" + await clickLink(FILE.sample));
    await page.sleep(500);
    const wide6 = await look("宽窗 · 点 sample.js:" + SAMPLE_HIT);
    check("换一个文件：内容跟着换", wide6.rowCount === 5);
    check("也停在那个文件的第 " + SAMPLE_HIT + " 行", wide6.hitNum === String(SAMPLE_HIT) && wide6.hitText.indexOf("sample " + SAMPLE_HIT) >= 0);
    check("新开一个标签（一共三个），前两格都还留着", wide6.tabCount === 3
        && wide6.projIndex === 0 && wide6.tabPaths[1] === FILE.long && wide6.tabPaths[2] === FILE.sample);
    check("新开的那个是当前这个标签", wide6.tabActive === 2 && activeFilePath(wide6) === FILE.sample);
    await page.shot("file-2b-two-tabs.png");

    // 再点已经开着的文件：切回它那个标签、按这次链接说的行滚过去，不新开标签
    console.log("点文件链接：" + await clickLink(FILE.long, HIT_LINE_AGAIN));
    await page.sleep(600);
    const wide7 = await look("宽窗 · 再点一次 long.js:" + HIT_LINE_AGAIN);
    check("同一个文件不再开一个标签（还是三个）", wide7.tabCount === 3
        && wide7.tabPaths[1] === FILE.long && wide7.tabPaths[2] === FILE.sample);
    check("切回 long.js 那个标签", wide7.tabActive === 1 && activeFilePath(wide7) === FILE.long);
    check("按这次链接说的第 " + HIT_LINE_AGAIN + " 行滚过去", wide7.hitNum === String(HIT_LINE_AGAIN) && wide7.hitVisible);
    await page.shot("file-8-switch-back.png");

    // 关掉一个没在看的标签：正看着的那个不许跟着换
    console.log("点标签上的叉：" + await clickTab(FILE.sample, "close"));
    await page.sleep(300);
    const wide7b = await look("宽窗 · 关掉没在看的 sample.js 那个标签");
    check("关掉没在看的标签：画面不换，还停在原来那一行", wide7b.tabCount === 2 && wide7b.tabActive === 1
        && activeFilePath(wide7b) === FILE.long && wide7b.hitNum === String(HIT_LINE_AGAIN) && wide7b.hitVisible);
    // 关过的文件再点开：又占一个新标签
    console.log("点文件链接：" + await clickLink(FILE.sample));
    await page.sleep(500);
    const wide7c = await look("宽窗 · 再点一次刚关掉的 sample.js");
    check("关过的文件再点开：又开一个标签、摆上来的还是它", wide7c.tabCount === 3
        && wide7c.tabPaths[2] === FILE.sample && wide7c.tabActive === 2);

    // 点标签切过去：回到那个标签上次读到的地方
    console.log("点标签：" + await clickTab(FILE.long, "tab"));
    await page.sleep(600);
    const wide8 = await look("宽窗 · 点 long.js 那个标签");
    check("点标签切到那个文件", wide8.tabActive === 1 && activeFilePath(wide8) === FILE.long && wide8.rowCount === LONG_LINES);
    check("回到它上次读到的地方（还停在刚才那一行）", wide8.hitNum === String(HIT_LINE_AGAIN) && wide8.hitVisible);
    check("三格标签都还在", wide8.tabCount === 3);

    // 切走再切回来：那一块原样摆回来（不重读文件、也不重画——重画一次就等于把读到哪儿、
    // 选中的字、图片解码、网页里的输入全丢掉）。给这一块做个记号，切回来记号还在就说明没重画。
    console.log("给 long.js 那一块做个记号：" + await page.eval(`
        const view = window.__fileView();
        const rows = Array.from(view.querySelectorAll(".file-line"));
        if (!rows[${HIT_LINE_AGAIN - 1}]) { return "没有那一行"; }
        rows[${HIT_LINE_AGAIN - 1}].setAttribute("data-mark", "keep");
        view.setAttribute("data-mark", "keep");
        return "记上了";
    `));
    console.log("点标签：" + await clickTab(FILE.sample, "tab"));
    await page.sleep(400);
    const awayTab = await look("宽窗 · 切到 sample.js 那一格");
    check("切到另一格：摆上来的是它自己那一块（行数都对）",
        awayTab.tabActive === 2 && activeFilePath(awayTab) === FILE.sample && awayTab.rowCount === 5,
        JSON.stringify({ active: awayTab.tabActive, rows: awayTab.rowCount }));
    console.log("点标签：" + await clickTab(FILE.long, "tab"));
    const backTab = JSON.parse(await page.eval(`
        const view = window.__fileView();
        const rows = Array.from(view.querySelectorAll(".file-line"));
        const row = rows[${HIT_LINE_AGAIN - 1}] || null;
        return JSON.stringify({
            mark: view.getAttribute("data-mark") || "",
            rowMark: row ? (row.getAttribute("data-mark") || "") : "没有这一行",
            rows: rows.length,
            note: (view.querySelector(".file-note") || {}).textContent || "",
            pages: document.querySelectorAll("#fileBody .file-page").length,
            shown: document.querySelectorAll("#fileBody .file-page:not([hidden])").length,
        });
    `));
    check("切回来：还是刚才那一块（没重画、记号还在，中间也没闪过「正在读取…」）",
        backTab.mark === "keep" && backTab.rowMark === "keep" && backTab.rows === LONG_LINES
        && backTab.note === "" && backTab.shown === 1,
        JSON.stringify(backTab));

    // 关掉正看着的那个：摆上剩下那一个
    console.log("点标签上的叉：" + await clickTab(FILE.long, "close"));
    await page.sleep(600);
    const wide9 = await look("宽窗 · 关掉正看着的 long.js 那个标签");
    check("关掉的那个标签没了、另一个还在", wide9.tabCount === 2 && wide9.tabPaths[1] === FILE.sample);
    check("面板还开着、没跟着标签一起收起", wide9.open && wide9.dock && wide9.panelShown);
    check("剩下那个标签摆上来（内容换成它的）", wide9.tabActive === 1 && activeFilePath(wide9) === FILE.sample && wide9.rowCount === 5);
    await page.shot("file-8b-one-tab-closed.png");

    // 文件标签全关掉：「目录」那一格还在，就摆上它（这一列不收起）
    console.log("点标签上的叉：" + await clickTab(FILE.sample, "close"));
    const wide10 = await waitLook("文件标签全关掉、目录摆上来", (x) => x.tabCount === 1 && x.entryCount > 0 && x.tabActive === 0);
    check("文件标签全关掉：面板不收起", wide10.open && wide10.dock && wide10.panelShown);
    check("剩下「目录」那一格摆上来（还是会话目录那份清单）", wide10.projCount === 1 && wide10.projIndex === 0
        && wide10.tabActive === 0 && samePathText(projTitle(wide10), cwd) && wide10.entryPaths.indexOf(FILE.long) >= 0
        && wide10.rowCount === 0 && wide10.note === "",
        JSON.stringify({ count: wide10.tabCount, path: projTitle(wide10) }));
    check("「目录」那一格上没有那颗叉（关不掉，一直占着第一格）",
        wide10.projClose === false && wide10.tabCloseCount === 0);
    await page.shot("file-9-all-file-tabs-closed.png");

    // 刷新：文件标签不恢复，「目录」那一格回到会话目录本身
    //（先把那一格走到子目录里、再点开一个文件：两件事都不是空话）
    console.log("点目录链接：" + await clickDir(DIR.top));
    const dirBeforeReload = await waitLook("刷新之前先走进一个子目录",
        (x) => x.entryCount === DIR_TOP_NAMES.length && x.tabActive === x.projIndex);
    check("刷新之前：「目录」那一格已经走到子目录里",
        dirBeforeReload.tabPaths[dirBeforeReload.projIndex] === DIR.top
        && headOk(dirBeforeReload, cwd, DIR.top), JSON.stringify({ hover: projTitle(dirBeforeReload) }));
    console.log("点文件链接：" + await clickLink(FILE.long));
    const beforeReload = await waitLook("刷新之前点开 long.js", (x) => x.tabCount === 2 && x.rowCount === LONG_LINES);
    check("刷新之前：文件还是开在「目录」后面那一格",
        beforeReload.projIndex === 0 && beforeReload.tabActive === 1 && beforeReload.tabPaths[1] === FILE.long
        && activeFilePath(beforeReload) === FILE.long && beforeReload.projClose === false, JSON.stringify(beforeReload.tabPaths));
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await installFileView();
    const wide11 = await waitLook("刷新之后目录那一格回来", (x) => x.projCount === 1 && x.entryCount > 0);
    check("刷新之后：第一个标签还是当前会话的目录",
        wide11.open && wide11.dock && wide11.projIndex === 0 && wide11.tabActive === 0
        && projTitle(wide11) === cwd && wide11.entryPaths.indexOf(FILE.long) >= 0,
        JSON.stringify({ count: wide11.tabCount, title: projTitle(wide11) }));
    check("刷新之后：「目录」那一格回到会话目录本身（不记住刚才走到哪一层）",
        wide11.tabPaths[wide11.projIndex] === "." && !wide11.upShown,
        JSON.stringify({ path: wide11.tabPaths[wide11.projIndex], up: wide11.upShown }));
    check("刷新之前开着的 long.js 那格没回来（面板里只有「目录」这一格）",
        wide11.tabCount === 1 && wide11.tabPaths.indexOf(FILE.long) < 0,
        JSON.stringify({ count: wide11.tabCount, paths: wide11.tabPaths }));
    await page.eval(POST_LINKS);
    await page.sleep(300);

    // ==================== 跟着刷新：正看着的文件被改了，这一列自己跟上 ====================
    // 脚本直接改会话目录里的 live.js（谁改的都一样：模型改的、脚本改的）：这一列该自己把新内容
    // 换上来，而读到哪儿还停在哪儿；文件没变的那几轮里，正文一个字节都不该再传一遍。
    console.log("点文件链接：" + await clickLink(FILE.live, LIVE_HIT));
    const live0 = await waitLook("live.js 上来", (x) => x.rowCount === LIVE_LINES && x.tabActive === 1);
    check("点链接打开 live.js、停在链接说的那一行", live0.rowCount === LIVE_LINES
        && live0.hitNum === String(LIVE_HIT) && live0.hitVisible);
    check("停在中间一段（后面验“位置不动”才不是白验）", live0.bodyTop > 0 && live0.bodyTop < live0.bodyMax,
        JSON.stringify({ top: live0.bodyTop, max: live0.bodyMax }));
    await page.shot("file-11-live.png");

    await page.eval(PROBE);
    await page.eval("window.__fileProbe.length = 0; return true;");
    console.log("文件没变，等两轮（界面在后台？" + live0.hidden + "）…");
    await page.sleep(3600);
    const probe0 = JSON.parse(await page.eval("return JSON.stringify(window.__fileProbe)"));
    const polled = probe0.filter((r) => r.mtime);
    console.log("这 3.6 秒里打 /file 的请求：" + JSON.stringify(probe0));
    check("面板按固定间隔自己问（文件没变也问）", polled.length >= 2, "问了 " + polled.length + " 次");
    check("没变的那些轮：回的是空响应、正文一个字节都没再传一遍",
        probe0.length > 0 && probe0.length === polled.length && polled.every((r) => r.status === 204 && r.bytes === 0),
        JSON.stringify(probe0.map((r) => [r.status, r.bytes])));
    const idle = await look("干等两轮 · 文件没变");
    check("文件没变：画面也不动（还停在同一行）", idle.rowCount === LIVE_LINES && idle.bodyTop === live0.bodyTop
        && idle.hitNum === String(LIVE_HIT), JSON.stringify({ top: idle.bodyTop }));

    // 脚本改文件：改的是正看着的那一行，行数不变
    writeLive(cwd, true, 0);
    const changed = await waitLook("面板换成改过的内容", (x) => x.hitText.indexOf("改过了") >= 0);
    check("文件被改以后，面板自己换成新内容（不用重新点链接）", changed.hitText.indexOf("改过了") >= 0, changed.hitText);
    check("行数、停在的那一行都还在", changed.rowCount === LIVE_LINES && changed.hitNum === String(LIVE_HIT));
    check("滚动位置一点没动（读到哪儿还停在哪儿）", changed.bodyTop === live0.bodyTop,
        JSON.stringify({ before: live0.bodyTop, after: changed.bodyTop }));
    check("标签没被这次刷新搅乱（还是那两格、还是当前这个）", changed.tabCount === 2 && changed.tabActive === 1);
    const probe1 = JSON.parse(await page.eval("return JSON.stringify(window.__fileProbe)"));
    check("变了才给正文：这回有一条 200 带着新正文回来",
        probe1.some((r) => r.status === 200 && r.bytes > 0), JSON.stringify(probe1.slice(-3)));
    await page.shot("file-12-follow-change.png");

    // 文件变长（末尾多出几行）：内容跟着长，人读到的位置还是不动
    writeLive(cwd, true, 40);
    const grown = await waitLook("面板换成多出 40 行的内容", (x) => x.rowCount === LIVE_LINES + 40);
    check("文件变长：面板也跟着长（末尾多了那 40 行）", grown.rowCount === LIVE_LINES + 40, String(grown.rowCount));
    check("文件变长也不动滚动位置", grown.bodyTop === live0.bodyTop,
        JSON.stringify({ before: live0.bodyTop, after: grown.bodyTop }));

    // 删掉又被写回来：先给一句「没有这个文件」，写回来以后自己换回内容
    fs.rmSync(path.join(cwd, FILE.live), { force: true });
    const gone = await waitLook("面板说没有这个文件", (x) => x.note.indexOf("没有这个文件") >= 0);
    check("文件被删掉：面板自己给一句「没有这个文件」", gone.rowCount === 0 && gone.note.indexOf("没有这个文件") >= 0, gone.note);
    writeLive(cwd, false, 0);
    const back = await waitLook("面板换回内容", (x) => x.rowCount === LIVE_LINES);
    check("文件写回来：面板自己又显示出来（还停在原来那一行）", back.rowCount === LIVE_LINES
        && back.hitNum === String(LIVE_HIT), String(back.rowCount));
    check("一路都是 live.js 那一个标签", back.tabCount === 2 && back.tabPaths[1] === FILE.live && back.tabActive === 1);
    await page.shot("file-13-live-back.png");

    // ==================== 门槛：1200px ====================
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1199, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const edge1 = await look("1199px");
    check("1199px 不是常驻（从左边滑入）", edge1.open && !edge1.dock && edge1.backdropShown && edge1.chatLeft === 0);
    check("滑入式里对话那边盖着一层（点它就是点外面）", edge1.topAtChat === "fileBackdrop" && edge1.topAtRight === "fileBackdrop",
        JSON.stringify({ chat: edge1.topAtChat, right: edge1.topAtRight }));
    await page.shot("file-3-narrow-drawer.png");
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const edge2 = await look("1200px");
    check("1200px 起常驻在左边、对话让出宽度", edge2.dock && edge2.chatLeft === FILE_W_DEFAULT && !edge2.backdropShown);

    // 滑入式里点外面收起（不写进记忆：宽回来还是开着的那种要单独验，这里只验收起）
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(400);
    await page.eval(`document.getElementById("fileBackdrop").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await page.sleep(300);
    const edge3 = await look("1000px · 点外面");
    check("滑入式里点外面收起", !edge3.open && !edge3.panelShown);

    // ==================== 手机上两块侧边栏互斥 ====================
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(600);
    await page.click("#browserMenuBtn");
    await page.sleep(800);
    const phone1 = JSON.parse(await page.eval(`
        return JSON.stringify({
            right: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            left: document.body.classList.contains("file-open"),
        });
    `));
    check("手机上先把右边那块开起来", phone1.right && !phone1.left);
    console.log("点文件链接：" + await clickLink(FILE.long));
    await page.sleep(600);
    const phone2 = JSON.parse(await page.eval(`
        return JSON.stringify({
            right: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            left: document.body.classList.contains("file-open"),
            dock: document.body.classList.contains("file-dock"),
        });
    `));
    check("手机上开左边这块：右边那块自己收起", phone2.left && !phone2.right && !phone2.dock);
    await page.shot("file-4-phone-left.png");
    await page.click("#browserMenuBtn");
    await page.sleep(800);
    const phone3 = JSON.parse(await page.eval(`
        return JSON.stringify({
            right: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            left: document.body.classList.contains("file-open"),
        });
    `));
    check("手机上再开右边那块：左边那块自己收起", phone3.right && !phone3.left);
    await page.shot("file-5-phone-right.png");
    // 收掉右边的抽屉，后面的检查别被它挡着
    await page.eval(`document.getElementById("pickerOverlay").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 3, clientY: 3 })); return true;`);
    await page.sleep(400);

    // ==================== 看不了的时候给一句人话 ====================
    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    console.log("点文件链接：" + await clickLink(FILE.missing));
    await page.sleep(500);
    const miss = await look("点不存在的文件");
    check("不存在的文件：页面上给一句说明、不给内容", miss.rowCount === 0 && miss.note.indexOf("没有这个文件") >= 0, miss.note);
    console.log("点文件链接：" + await clickLink(FILE.outside));
    await page.sleep(500);
    const out = await look("点会话目录外面的文件");
    check("会话目录外：页面上给一句说明、不给内容", out.rowCount === 0 && out.note.indexOf("会话目录外") >= 0, out.note);
    console.log("点文件链接：" + await clickLink(FILE.big));
    await page.sleep(700);
    const big = await look("点超过 2 MB 的文件");
    check("超过 2 MB：页面上给一句说明、不给内容", big.rowCount === 0 && big.note.indexOf("太大") >= 0, big.note);
    // 手机那一段点过一次 long.js（占了第一个标签），这里又点了三个看不了的文件，各占一个
    check("看不了的文件也各占一个标签",
        big.tabPaths.indexOf(FILE.missing) >= 0 && big.tabPaths.indexOf(FILE.outside) >= 0
        && big.tabPaths.indexOf(FILE.big) >= 0 && big.tabActive === big.tabCount - 1,
        JSON.stringify(big.tabPaths));
    await page.shot("file-6-refused.png");

    // ==================== 工具卡片那颗「跳转」：跟正文里的文件链接去同一个地方 ====================
    // write 卡片收在工具行里那颗小标签上：鼠标停上去（触屏点一下）出提示框，里面那颗「跳转」
    // 在浏览器页面里该跟正文里的文件链接一样——左边那一列自己开出来、停在文件第一行。
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(400);
    await page.click("#fileSidebarBtn");   // 先收起来：验点「跳转」自己把它开出来
    await page.sleep(300);
    const jumpClosed = await look("点「跳转」之前 · 面板收着");
    check("点「跳转」之前：左边那一列收着", !jumpClosed.open && !jumpClosed.dock);

    await page.eval(`for (const m of ${JSON.stringify([
        { type: "editCardStart", toolCallId: JUMP_CARD_ID, toolName: "write", path: JUMP_FILE, label: JUMP_FILE, args: JUMP_ARGS },
        { type: "editCardResult", toolCallId: JUMP_CARD_ID, canRevert: false, diff: "" },
    ])}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(300);
    console.log("点 write 卡片那颗标签：" + await showJumpTip());
    const jumpBtn = await waitJumpBtn();
    check("write 卡片那颗标签的提示框里有一颗「跳转」", jumpBtn.found, jumpBtn.title);
    check("浏览器页面里那颗「跳转」说的是开在文件侧边栏里（不是编辑器）",
        jumpBtn.title.indexOf("文件侧边栏") >= 0 && jumpBtn.title.indexOf(JUMP_FILE) >= 0, jumpBtn.title);
    console.log("点「跳转」：" + await clickJumpBtn());
    const jump1 = await waitLook("跳转开的文件上来", (x) => x.rowCount === JUMP_LINES && activeFilePath(x) === JUMP_FILE);
    check("点工具卡片那颗「跳转」：左边那一列自己开出来", jump1.open && jump1.dock && jump1.panelShown);
    check("文件显示出来、带行号", jump1.rowCount === JUMP_LINES && jump1.firstRow.indexOf("1") >= 0, jump1.firstRow);
    check("开在「目录」后面那一格新标签里", jump1.projIndex === 0 && jump1.tabActive > 0
        && jump1.tabPaths[jump1.tabActive] === JUMP_FILE, JSON.stringify({ paths: jump1.tabPaths, active: jump1.tabActive }));
    check("停在第一行（跟以前交给编辑器打开时一个口径）", jump1.hitNum === "1" && jump1.hitVisible);
    await page.shot("file-26-tool-jump.png");

    // 收掉提示框与刚开的这一格标签，别给后面的检查留下遮挡 / 多余的标签
    await page.eval(`const h = document.getElementById("fileHeader"); if (h) { h.click(); } return true;`);
    await page.sleep(300);
    console.log("点标签上的叉：" + await clickTab(JUMP_FILE, "close"));
    await page.sleep(300);

    // ==================== 图片：点链接直接在这一列里看到那张图 ====================
    // 回到宽窗（前面那段在手机上跑）：这一列常驻在左边，图该按这一列的宽度等比例缩。
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    console.log("点文件链接：" + await clickLink(FILE.image));
    const img1 = await waitLook("图片上来", (x) => x.imgNatural[0] > 0);
    check("点图片链接：面板里直接显示出那张图（不是一行行看不懂的字符）",
        img1.imgCount === 1 && img1.imgNatural[0] === IMAGE_W && img1.imgNatural[1] === IMAGE_H && !img1.imgBroken,
        JSON.stringify({ img: img1.imgNatural, broken: img1.imgBroken }));
    check("图按面板宽度等比例缩、没撑破这一列",
        !!img1.imgShown && img1.imgShown.w > 100 && img1.imgShown.w <= FILE_W_DEFAULT
        && Math.abs(img1.imgShown.h - img1.imgShown.w * IMAGE_H / IMAGE_W) <= 2,
        JSON.stringify(img1.imgShown));
    check("图片不画行号、也不给那句「看不了」的说明",
        img1.rowCount === 0 && img1.note === "" && img1.downloadCount === 0 && img1.bodyChars < 200);
    check("图片占一个标签，面板头写着它",
        img1.tabActive === img1.tabPaths.length - 1 && img1.tabPaths[img1.tabActive] === FILE.image
        && activeFilePath(img1) === FILE.image);
    await page.shot("file-14-image.png");

    // 超过 2 MB 的真图：图片自己那条线比文本宽，照样直接看（不用点下载）
    console.log("点文件链接：" + await clickLink(FILE.bigImage));
    const imgBig = await waitLook("大图直接显示出来", (x) => x.imgNatural[0] === BIG_IMAGE_W);
    check("超过 2 MB 的图片：照样直接显示（图片上限是 20 MB，不是文本那道 2 MB）",
        imgBig.imgCount === 1 && imgBig.imgNatural[0] === BIG_IMAGE_W && imgBig.imgNatural[1] === BIG_IMAGE_H
        && !imgBig.imgBroken && imgBig.downloadCount === 0 && imgBig.note === "",
        JSON.stringify({ img: imgBig.imgNatural, broken: imgBig.imgBroken, download: imgBig.downloadCount, note: imgBig.note }));
    check("大图也是等比例缩到这一列的宽（不横着撑出去）",
        !!imgBig.imgShown && imgBig.imgShown.w <= FILE_W_DEFAULT
        && Math.abs(imgBig.imgShown.h - imgBig.imgShown.w * BIG_IMAGE_H / BIG_IMAGE_W) <= 2,
        JSON.stringify(imgBig.imgShown));
    await page.shot("file-14b-big-image.png");

    // 超过图片那道线（20 MB）：还是只给一句「太大」加下载，不整张塞进页面
    console.log("点文件链接：" + await clickLink(FILE.hugeImage));
    const imgHuge = await waitLook("超大图片那句说明上来", (x) => x.note.indexOf("太大") >= 0);
    check("超过 20 MB 的图片：给一句「太大」加下载",
        imgHuge.downloadCount === 1 && imgHuge.downloadText.indexOf("点这里下载") >= 0 && imgHuge.imgCount === 0,
        JSON.stringify({ note: imgHuge.note, text: imgHuge.downloadText }));

    // ==================== 二进制：一句说明 + 一个能存下来的下载 ====================
    console.log("点文件链接：" + await clickLink(FILE.binary));
    const bin1 = await waitLook("二进制那句说明上来", (x) => x.downloadCount > 0 || x.note.indexOf("二进制") >= 0);
    check("点二进制文件：给一句「这是个二进制文件」", bin1.note.indexOf("二进制文件") >= 0, bin1.note);
    check("二进制文件：给一个下载链接、正文一个字节都不给",
        bin1.rowCount === 0 && bin1.downloadCount === 1 && bin1.bodyChars < 300
        && bin1.downloadHref.indexOf("download=1") >= 0 && bin1.downloadHref.indexOf(encodeURIComponent(FILE.binary)) >= 0
        && bin1.downloadName === FILE.binary,
        JSON.stringify({ href: bin1.downloadHref, name: bin1.downloadName }));
    await page.shot("file-15-binary.png");

    // 点那个下载链接：让浏览器真的存一份下来（CDP 把下载指到一个临时目录），再核对字节数
    const downloadDir = path.join(require("./harness.js").SCRATCH_DIR, "downloads");
    fs.rmSync(downloadDir, { recursive: true, force: true });
    fs.mkdirSync(downloadDir, { recursive: true });
    const cdpSession = page.cdp.sessionId;
    page.cdp.sessionId = undefined;   // Browser 域的命令发在浏览器上，不带页面会话
    await page.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
    page.cdp.sessionId = cdpSession;
    console.log("点下载链接：" + await page.eval(`const a = window.__fileView().querySelector("a.file-download"); if (!a) { return "没有链接"; } a.click(); return "点了";`));
    const saved = await waitForFile(path.join(downloadDir, FILE.binary), 10000);
    check("点下载：文件真存了下来，字节一个不少",
        !!saved && fs.statSync(saved).size === BINARY_BYTES,
        saved ? path.basename(saved) + " " + fs.statSync(saved).size + " 字节" : "没等到文件");
    check("点下载不把页面顶掉（界面还在这儿）",
        await page.eval(`return !!document.getElementById("fileSidebar") && document.querySelectorAll(".session-view:not(.off) .session-pane").length > 0;`));

    // ==================== 超大文件：给「太大，点这里下载」 ====================
    console.log("点文件链接：" + await clickLink(FILE.big));
    const big2 = await waitLook("太大那句说明带上下载链接", (x) => x.downloadCount > 0 && x.note.indexOf("太大") >= 0);
    check("超过 2 MB：给「太大」加一个「点这里下载」",
        big2.downloadCount === 1 && big2.downloadText.indexOf("点这里下载") >= 0,
        JSON.stringify({ note: big2.note, text: big2.downloadText }));
    check("超过 2 MB：几 MB 的正文一个字节都没塞进页面",
        big2.rowCount === 0 && big2.bodyChars < 500, String(big2.bodyChars) + " 个字的正文");
    await page.shot("file-16-too-big.png");

    // 点这个超大文件的下载：几 MB 那一下也要真存得下来
    fs.rmSync(path.join(downloadDir, FILE.big), { force: true });
    console.log("点下载链接：" + await page.eval(`const a = window.__fileView().querySelector("a.file-download"); if (!a) { return "没有链接"; } a.click(); return "点了";`));
    const savedBig = await waitForFile(path.join(downloadDir, FILE.big), 20000);
    check("几 MB 的文件点下载也真存得下来（字节一个不少）",
        !!savedBig && fs.statSync(savedBig).size === BIG_BYTES,
        savedBig ? path.basename(savedBig) + " " + fs.statSync(savedBig).size + " 字节" : "没等到文件");

    // 超大 + 二进制：先说「太大」（不先说「二进制」），一样给下载
    console.log("点文件链接：" + await clickLink(FILE.bigBinary));
    const bigBin = await waitLook("超大那个二进制文件给「太大」", (x) => x.downloadCount > 0 && x.note.indexOf("太大") >= 0);
    check("超过 2 MB 的二进制文件：先说「太大」，并给下载",
        bigBin.note.indexOf("太大") >= 0 && bigBin.note.indexOf("二进制") < 0 && bigBin.downloadCount === 1,
        bigBin.note);

    // 下载在跑的时候界面还答得上话（几 MB 走单独的请求，页面这边不经手正文）
    const bigFetch = JSON.parse(await page.eval(`
        const sid = (document.querySelector(".session-view:not(.off) .session-pane") || { dataset: {} }).dataset.sessionId || "";
        const url = "/file?session=" + encodeURIComponent(sid) + "&path=" + encodeURIComponent(${JSON.stringify(FILE.big)}) + "&download=1";
        return (async function () {
            const started = performance.now();
            const pending = fetch(url).then(function (r) { return r.arrayBuffer(); });
            // 几 MB 还在流的时候：这一列还在、界面这边照样答得上话
            const t0 = performance.now();
            const panelThere = !!document.getElementById("fileBody");
            document.getElementById("fileTabs").getBoundingClientRect();
            const uiMs = Math.round(performance.now() - t0);
            const buf = await pending;
            return JSON.stringify({ bytes: buf.byteLength, ms: Math.round(performance.now() - started), uiMs: uiMs, panelThere: panelThere });
        })();
    `));
    check("几 MB 的文件整份下得下来（走下载那条请求）",
        bigFetch.bytes === BIG_BYTES, bigFetch.bytes + " / " + BIG_BYTES + " 字节，用了 " + bigFetch.ms + "ms");
    check("下载在跑的时候界面还答得上话（没被正文堵住）",
        bigFetch.panelThere && bigFetch.uiMs < 500, "界面回话用了 " + bigFetch.uiMs + "ms");

    // ==================== 目录：都在「目录」那一格里走，不开新标签 ====================
    // 消息流里以斜杠结尾的写法算目录链接（不带斜杠、又不带扩展名的写法不认：`and/or` 里的 `and/`
    // 不该变成路径）。点它：切到「目录」那一格、列出里面的东西；子目录接着点、文件点开看；
    // 列出来的东西一样受「只在会话目录内」的限制（指到外面的软链接列得出来，点不了）。
    // 目录不占标签：进目录、换目录都在第一格里发生，清单最上面一行「上一层」往回退。
    const dirLinks = JSON.parse(await page.eval(`
        const all = Array.from(document.querySelectorAll("a.file-link"));
        const dirs = all.filter(function (a) { return a.getAttribute("data-dir") === "1"; });
        return JSON.stringify({
            dirPaths: dirs.map(function (a) { return a.getAttribute("data-file") || ""; }),
            inCode: dirs.filter(function (a) { return !!a.closest("code"); }).length,
            plain: dirs.filter(function (a) { return !a.closest("code"); }).length,
            andPaths: all.filter(function (a) { return (a.getAttribute("data-file") || "").indexOf("and/") === 0; }).length,
            text: (document.getElementById("messages") || {}).textContent || "",
        });
    `));
    check("消息流里以斜杠结尾的写法算目录链接",
        dirLinks.dirPaths.indexOf(DIR.top + "/") >= 0 && dirLinks.dirPaths.indexOf(DIR.sub + "/") >= 0
        && dirLinks.dirPaths.indexOf(DIR.empty + "/") >= 0 && dirLinks.dirPaths.indexOf("outside/") >= 0,
        JSON.stringify(dirLinks.dirPaths));
    check("目录链接两种写法都认（行内代码里的与普通文字里的）", dirLinks.inCode >= 4 && dirLinks.plain >= 1,
        JSON.stringify({ inCode: dirLinks.inCode, plain: dirLinks.plain }));
    check("英文里的 and/or 不认成路径", dirLinks.andPaths === 0 && dirLinks.text.indexOf("and/or") >= 0);

    // 先收起这一列再点目录链接：它自己该开出来（跟文件链接一样）
    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    const beforeDir = await look("点目录链接之前");
    console.log("点目录链接：" + await clickDir(DIR.top));
    const dir1 = await waitLook("目录清单上来", (x) => x.entryCount === DIR_TOP_NAMES.length);
    check("点目录链接：面板自己开出来（不用先点按钮）", dir1.open && dir1.dock && dir1.panelLeft === 0);
    check("面板里列的是里面的东西（不是文件正文）",
        dir1.entryCount === DIR_TOP_NAMES.length && dir1.rowCount === 0 && dir1.note === "");
    check("子目录在前、文件在后，各按名字排",
        JSON.stringify(dir1.entryNames.map(function (n) { return n.replace(/\/$/, ""); })) === JSON.stringify(DIR_TOP_NAMES),
        JSON.stringify(dir1.entryNames));
    check("目录名带一个斜杠、文件名不带（一眼看出哪些是目录）",
        dir1.entryNames.every(function (n, i) { return (n.slice(-1) === "/") === dir1.entryDirs[i]; }),
        JSON.stringify(dir1.entryNames));
    check("每一项说得出是不是目录", JSON.stringify(dir1.entryDirs) === JSON.stringify([true, true, true, false, false, false, false]),
        JSON.stringify(dir1.entryDirs));
    check("清单里的路径都是相对会话目录的写法",
        dir1.entryPaths.every(function (p) { return p.indexOf(DIR.top + "/") === 0; }), JSON.stringify(dir1.entryPaths));
    check("目录不新开标签：切到「目录」那一格显示它（标签上还是那四个字）",
        dir1.tabCount === beforeDir.tabCount && dir1.projIndex === 0 && dir1.tabActive === dir1.projIndex
        && dir1.tabNames[dir1.projIndex] === "目录" && dir1.tabPaths[dir1.projIndex] === DIR.top,
        JSON.stringify({ before: beforeDir.tabCount, after: dir1.tabCount, names: dir1.tabNames, paths: dir1.tabPaths }));
    check("这一列头上不写路径：最上面那一行就是标签条（「目录」那一格悬停给这一层的全路径）",
        headOk(dir1, cwd, DIR.top) && projName(dir1) === "目录",
        JSON.stringify({ hover: projTitle(dir1) }));
    check("进到子目录里：清单最上面一行出现「上一层」（不在上面那一行标签里）",
        dir1.upShown && dir1.upFirstRow && !dir1.upInHeader && dir1.upText.indexOf("上一层") >= 0
        && dir1.headerBtnCount === 1,
        JSON.stringify({ shown: dir1.upShown, first: dir1.upFirstRow, inHeader: dir1.upInHeader,
            text: dir1.upText, header: dir1.headerBtnCount }));
    check("「上一层」这一行在面板里面（没被挤出这一列）",
        dir1.upInside && dir1.closeInside,
        JSON.stringify({ up: dir1.upInside, close: dir1.closeInside }));
    // 图片那一行挂的是它自己的小图：20×20 大小的小图，缩略图只挂给 2 MB 以内的（免得一目录大图全拉下来）
    const thumb1 = await waitLook("清单里那张小图的缩略图上来", (x) => x.thumbLoaded > 0);
    check("目录清单里图片那一行挂的是它自己的小图（别的行还是通用图标）",
        thumb1.thumbCount === 1 && thumb1.thumbPaths[0] === DIR.thumbImage,
        JSON.stringify({ count: thumb1.thumbCount, paths: thumb1.thumbPaths, loaded: thumb1.thumbLoaded }));
    check("清单里超过 2 MB 的图片不挂缩略图（点开照样能看）",
        thumb1.thumbPaths.indexOf(DIR.bigImage) < 0, JSON.stringify(thumb1.thumbPaths));
    await page.shot("file-17-dir.png");

    // 点子目录：还在「目录」这一格里往里走，不新开标签
    console.log("点清单里的子目录：" + await clickEntry(DIR.sub));
    const dir2 = await waitLook("子目录的清单上来", (x) => x.entryCount === 1);
    check("点子目录接着列（一层层往下走）", dir2.entryCount === 1 && dir2.entryNames[0] === "three.js"
        && dir2.entryDirs[0] === false, JSON.stringify({ names: dir2.entryNames, dirs: dir2.entryDirs }));
    check("还在「目录」那一格里（不新开标签）", dir2.tabCount === dir1.tabCount
        && dir2.tabActive === dir2.projIndex && dir2.tabPaths[dir2.projIndex] === DIR.sub,
        JSON.stringify({ count: dir2.tabCount, paths: dir2.tabPaths }));
    check("进了子目录也一样：头上不写路径，悬停提示跟着换成这一层",
        headOk(dir2, cwd, DIR.sub),
        JSON.stringify({ hover: projTitle(dir2) }));
    await page.shot("file-18-dir-sub.png");

    // 点清单里的文件：在这一列里显示它（带行号）——文件还是开一个新标签
    console.log("点清单里的文件：" + await clickEntry(DIR.subFile));
    const dir3 = await waitLook("清单里那个文件的内容上来", (x) => x.rowCount === DIR_SUB_FILE_LINES);
    check("点清单里的文件：面板里显示它（带行号）", dir3.rowCount === DIR_SUB_FILE_LINES
        && dir3.firstRow.indexOf("three 第 1 行") >= 0 && dir3.entryCount === 0);
    check("清单里的文件照旧开一个新标签（标签是给文件的）", dir3.tabCount === dir2.tabCount + 1
        && dir3.tabPaths[dir3.tabActive] === DIR.subFile && activeFilePath(dir3) === DIR.subFile);
    await page.shot("file-19-dir-file.png");

    // 「上一层」：点清单第一行那一行退到上一层，还是「目录」这一格那份清单
    console.log("点「目录」那一格：" + await clickProjTab());
    const up0 = await waitLook("子目录那份清单又摆上来",
        (x) => x.entryCount === 1 && x.tabActive === x.projIndex);
    check("点「目录」那一格：还是刚才走到的这一层（悬停提示写着它）",
        up0.tabPaths[up0.projIndex] === DIR.sub && headOk(up0, cwd, DIR.sub), JSON.stringify({ hover: projTitle(up0) }));
    console.log("点清单第一行「上一层」：" + await clickUp());
    const up1 = await waitLook("退回上一层", (x) => x.entryCount === DIR_TOP_NAMES.length && x.tabActive === x.projIndex);
    check("点「上一层」：退到上一层（还是那一格清单、没多出标签）",
        up1.tabCount === up0.tabCount && up1.tabPaths[up1.projIndex] === DIR.top
        && headOk(up1, cwd, DIR.top)
        && JSON.stringify(up1.entryNames.map(function (n) { return n.replace(/\/$/, ""); })) === JSON.stringify(DIR_TOP_NAMES),
        JSON.stringify({ count: up1.tabCount, path: up1.tabPaths[up1.projIndex], hover: projTitle(up1) }));
    await page.shot("file-18b-dir-up.png");
    console.log("再点一次「上一层」：" + await clickUp());
    const up2 = await waitLook("退回会话目录本身",
        (x) => x.tabActive === x.projIndex && x.entryPaths.indexOf(DIR.top) >= 0 && x.entryPaths.indexOf(FILE.long) >= 0);
    check("退到会话目录本身：列的就是会话目录里的东西", up2.entryCount > 0 && up2.rowCount === 0 && up2.note === ""
        && up2.tabPaths[up2.projIndex] === "." && headOk(up2, cwd),
        JSON.stringify({ path: up2.tabPaths[up2.projIndex], hover: projTitle(up2) }));
    check("已经在最外面那一层：「上一层」不出现（不许走到会话目录外面）", !up2.upShown);

    // 清单里那颗指到会话目录外面的软链接：列得出来，点不了
    //（先点进 dirA，把那张清单摆上来）
    console.log("点清单里的子目录：" + await clickEntry(DIR.top));
    const dir3b = await waitLook("回目录清单", (x) => x.entryCount === DIR_TOP_NAMES.length && x.tabActive === x.projIndex);
    console.log("点清单里的目录外链接：" + await clickEntry(DIR.outLink));
    const dir4 = await waitLook("目录外那句说明上来", (x) => x.note.indexOf("会话目录外") >= 0);
    check("清单里指到目录外的东西：点不了、给一句说明（还是这一格）", dir3b.entryPaths.indexOf(DIR.outLink) >= 0
        && dir4.entryCount === 0 && dir4.rowCount === 0 && dir4.note.indexOf("会话目录外") >= 0
        && dir4.tabActive === dir4.projIndex, dir4.note);
    check("看不了的那一层也留着「上一层」（不然就退不回去了）", dir4.upShown && dir4.upFirstRow);

    // 空目录与目录外的目录（都从消息流里的链接点进去）
    console.log("点目录链接：" + await clickDir(DIR.empty));
    const dir5 = await waitLook("空目录那句提示上来", (x) => x.note.indexOf("目录是空的") >= 0);
    check("空目录：给一句「这个目录是空的」", dir5.entryCount === 0
        && dir5.note.indexOf("目录是空的") >= 0, dir5.note);
    check("空目录里「上一层」那一行还在（空的是这一层，不是它的上面）", dir5.upShown && dir5.upFirstRow);
    console.log("点目录链接：" + await clickDir("outside"));
    const dir6 = await waitLook("目录外那句说明上来", (x) => x.note.indexOf("会话目录外") >= 0);
    check("会话目录外的目录：给一句说明、不给清单", dir6.entryCount === 0 && dir6.rowCount === 0
        && dir6.note.indexOf("会话目录外") >= 0, dir6.note);

    // 同一张清单盯着看两轮：目录不该被「跟着刷新」那一套当成文件去问
    console.log("点目录链接：" + await clickDir(DIR.top));
    const dir7 = await waitLook("目录清单再上来", (x) => x.entryCount === DIR_TOP_NAMES.length);
    await page.sleep(3400);
    const dir8 = await look("盯着目录清单等两轮");
    check("目录那一格不会被「跟着刷新」那一套换掉（还是那张清单）", dir8.entryCount === DIR_TOP_NAMES.length
        && dir8.note === ""
        && JSON.stringify(dir8.entryNames.map(function (n) { return n.replace(/\/$/, ""); })) === JSON.stringify(DIR_TOP_NAMES),
        JSON.stringify(dir8.entryNames));
    check("再点同一个目录：还是那一格（不重复开、不新开）",
        dir8.tabCount === dir7.tabCount && dir8.tabPaths[dir8.projIndex] === DIR.top
        && dir8.tabActive === dir8.projIndex);
    await page.shot("file-20-dir-again.png");

    // 东西太多的目录：只列一部分，这一列里说一句（不把几百上千项全塞进页面）
    console.log("点目录链接：" + await clickDir(DIR.huge));
    const dir9 = await waitLook("大目录的清单上来", (x) => x.entryCount > 0 && x.note.indexOf("太多") >= 0);
    check("目录里东西太多：只列前 " + DIR_MAX_ENTRIES + " 个、面板里说一句",
        dir9.entryCount === DIR_MAX_ENTRIES && dir9.note.indexOf("太多") >= 0,
        JSON.stringify({ count: dir9.entryCount, note: dir9.note }));
    check("进大目录也还是「目录」那一格（不新开标签）",
        dir9.tabCount === dir8.tabCount && dir9.tabActive === dir9.projIndex && dir9.tabPaths[dir9.projIndex] === DIR.huge,
        JSON.stringify({ count: dir9.tabCount, path: dir9.tabPaths[dir9.projIndex] }));
    await page.shot("file-21-dir-huge.png");

    // 从「目录」那一格往下点：跟点消息里那些目录链接是同一套清单（子目录接着列、文件点开看）
    console.log("点清单第一行「上一层」：" + await clickUp());
    const proj1 = await waitLook("退回会话目录那一层",
        (x) => x.tabActive === x.projIndex && x.upShown === false && x.entryPaths.indexOf(FILE.long) >= 0);
    check("点「上一层」退出大目录：回到会话目录本身那份清单",
        proj1.entryCount > 0 && proj1.rowCount === 0 && proj1.note === ""
        && proj1.tabPaths[proj1.projIndex] === "." && proj1.entryPaths.indexOf(DIR.top) >= 0
        && headOk(proj1, cwd),
        JSON.stringify({ path: proj1.tabPaths[proj1.projIndex], hover: projTitle(proj1) }));
    console.log("点清单里的子目录：" + await clickEntry(DIR.top));
    const proj2 = await waitLook("从目录点进子目录",
        (x) => x.entryCount === DIR_TOP_NAMES.length && x.tabActive === x.projIndex);
    check("从目录那一格点进子目录：接着列（同一格、不新开标签）",
        JSON.stringify(proj2.entryNames.map(function (n) { return n.replace(/\/$/, ""); })) === JSON.stringify(DIR_TOP_NAMES)
        && proj2.tabCount === proj1.tabCount && proj2.tabPaths[proj2.projIndex] === DIR.top
        && headOk(proj2, cwd, DIR.top),
        JSON.stringify({ count: proj2.tabCount, path: proj2.tabPaths[proj2.projIndex], hover: projTitle(proj2) }));
    console.log("点清单里的文件：" + await clickEntry(DIR.topFile));
    const proj3 = await waitLook("从目录点开文件", (x) => x.rowCount === DIR_ONE_LINES);
    check("从目录那一格点开文件：显示它（带行号、跟票 05 一样）", proj3.rowCount === DIR_ONE_LINES
        && proj3.firstRow.indexOf("one 第 1 行") >= 0 && activeFilePath(proj3) === DIR.topFile && proj3.entryCount === 0);
    check("点开的文件排在「目录」后面那一格（目录那一格没被顶掉）",
        proj3.tabCount === proj2.tabCount + 1 && proj3.projIndex === 0 && proj3.tabActive === proj3.tabCount - 1
        && proj3.tabNames[proj3.projIndex] === "目录", JSON.stringify(proj3.tabNames));

    // ==================== 认得的几种语言带颜色 ====================
    // 按扩展名认语言：TypeScript（含 JavaScript 与 JSON 那几个别名）、C++、Python——认语言与别名
    // 跟消息流里那一套是同一处（chat.js 的 resolveHighlightLanguage），不另起一套。其余语言黑白；
    // 行号还在、跟内容对得上；跨多行的注释 / 模板串不会在行号那儿断开。
    // 正文太大的不上色：整段高亮几万行会把页面卡住，这一条用 1.5 MB 的文件盯着（见下）。
    await page.eval(`for (const m of ${JSON.stringify([{ type: "assistantFull", text: COLOR_LINK_TEXT }])}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(400);

    /** 这一列里现在这一段正文的逐行样子：行号、文字、每行里那几个上了色的记号、颜色。 */
    const colorLook = async () => JSON.parse(await page.eval(`
        const body = window.__fileView();
        const rows = Array.from(body.querySelectorAll(".file-line"));
        const kinds = {};
        let tokens = 0;
        const lineClasses = rows.map(function (r) {
            return Array.from(r.querySelectorAll(".file-text [class*='hljs-']")).map(function (s) {
                tokens++;
                s.classList.forEach(function (c) { if (c.indexOf("hljs-") === 0) { kinds[c] = (kinds[c] || 0) + 1; } });
                return s.className;
            });
        });
        const palette = {};
        ["hljs-keyword", "hljs-string", "hljs-number", "hljs-comment", "hljs-type", "hljs-built_in", "hljs-meta"].forEach(function (k) {
            const s = body.querySelector(".file-text ." + k);
            palette[k] = s ? getComputedStyle(s).color : "";
        });
        return JSON.stringify({
            rowCount: rows.length,
            nums: rows.map(function (r) { return (r.querySelector(".file-num") || {}).textContent || ""; }),
            texts: rows.map(function (r) { return (r.querySelector(".file-text") || {}).textContent || ""; }),
            lineClasses: lineClasses,
            base: rows.length ? getComputedStyle(rows[0].querySelector(".file-text")).color : "",
            tokens: tokens, kinds: kinds, palette: palette,
        });
    `));
    /** 行号还在、每一行的字跟原文一字不差（上色的行拆开以后不许串行、不许丢字）。 */
    const sameLines = (r, want) => r.rowCount === want.length
        && r.nums.every((n, i) => n === String(i + 1))
        && r.texts.every((t, i) => t === want[i]);
    /** 点开一个带颜色的文件（line 是投出去那句话里链接说的行）、等它画上来。 */
    const openColor = async (file, line, wantRows) => {
        console.log("点文件链接：" + await clickLink(file, line));
        return await waitLook("带颜色的 " + file + " 上来", (x) => x.rowCount === wantRows, 15000);
    };
    /** 页面上最长一次「卡住没答理」有多久（对着一堆行画那一下）：先摆上秒表、点完再读。 */
    const startFreezeWatch = () => page.eval(`
        window.__gaps = [];
        var last = performance.now();
        (function tick() { const now = performance.now(); window.__gaps.push(now - last); last = now; requestAnimationFrame(tick); })();
        return true;
    `);
    const readFreeze = async () => Number(await page.eval(`return window.__gaps && window.__gaps.length ? Math.round(Math.max.apply(null, window.__gaps)) : -1;`));

    await openColor(COLOR.ts, 3, COLOR_TS_LINES.length);
    const tsCol = await colorLook();
    check("TypeScript 文件显示时带颜色（关键字、字符串、注释各自有着色）",
        tsCol.tokens > 0 && tsCol.kinds["hljs-keyword"] > 0 && tsCol.kinds["hljs-string"] > 0
        && tsCol.kinds["hljs-comment"] > 0, JSON.stringify(tsCol.kinds));
    check("上色以后行号还在、每一行的字跟原文一字不差", sameLines(tsCol, COLOR_TS_LINES), JSON.stringify(tsCol.texts.slice(0, 3)));
    check("颜色是几种不同的颜色（不是整段一个色）",
        tsCol.palette["hljs-keyword"] !== "" && tsCol.palette["hljs-keyword"] !== tsCol.base
        && tsCol.palette["hljs-keyword"] !== tsCol.palette["hljs-comment"]
        && tsCol.palette["hljs-string"] !== tsCol.base, JSON.stringify(tsCol.palette));
    check("跨行的块注释与模板串：两行都还带着原来的颜色（没在行号那儿断开）",
        tsCol.lineClasses[8].some((c) => c.indexOf("hljs-comment") >= 0)
        && tsCol.lineClasses[9].some((c) => c.indexOf("hljs-comment") >= 0)
        && tsCol.lineClasses[10].some((c) => c.indexOf("hljs-string") >= 0)
        && tsCol.lineClasses[11].some((c) => c.indexOf("hljs-string") >= 0),
        JSON.stringify([tsCol.lineClasses[8], tsCol.lineClasses[9], tsCol.lineClasses[10], tsCol.lineClasses[11]]));
    await page.shot("file-22-color-ts.png");

    await openColor(COLOR.js, 3, COLOR_JS_LINES.length);
    const jsCol = await colorLook();
    check("JavaScript 文件也带颜色（js 是 TypeScript 的别名，跟消息流里认的是同一套）",
        sameLines(jsCol, COLOR_JS_LINES) && jsCol.kinds["hljs-keyword"] > 0, JSON.stringify(jsCol.kinds));

    await openColor(COLOR.json, 3, COLOR_JSON_LINES.length);
    const jsonCol = await colorLook();
    check("JSON 文件也带颜色（json 有别名指到 TypeScript）",
        sameLines(jsonCol, COLOR_JSON_LINES) && jsonCol.kinds["hljs-string"] > 0 && jsonCol.kinds["hljs-number"] > 0,
        JSON.stringify(jsonCol.kinds));

    await openColor(COLOR.cpp, 3, COLOR_CPP_LINES.length);
    const cppCol = await colorLook();
    check("C++ 文件带颜色（关键字、预处理指令、注释、字符串各自有着色）",
        sameLines(cppCol, COLOR_CPP_LINES) && cppCol.kinds["hljs-keyword"] > 0 && cppCol.kinds["hljs-meta"] > 0
        && cppCol.kinds["hljs-string"] > 0 && cppCol.kinds["hljs-comment"] > 0, JSON.stringify(cppCol.kinds));
    check("C++ 那个跨行的块注释：两行都还是注释的颜色",
        cppCol.lineClasses[5].some((c) => c.indexOf("hljs-comment") >= 0)
        && cppCol.lineClasses[6].some((c) => c.indexOf("hljs-comment") >= 0),
        JSON.stringify([cppCol.lineClasses[5], cppCol.lineClasses[6]]));
    await page.shot("file-23-color-cpp.png");

    await openColor(COLOR.py, 1, COLOR_PY_LINES.length);
    const pyCol = await colorLook();
    check("Python 文件带颜色（关键字、内置函数、字符串、注释各自有着色）",
        sameLines(pyCol, COLOR_PY_LINES) && pyCol.kinds["hljs-keyword"] > 0 && pyCol.kinds["hljs-built_in"] > 0
        && pyCol.kinds["hljs-string"] > 0 && pyCol.kinds["hljs-comment"] > 0, JSON.stringify(pyCol.kinds));
    await page.shot("file-24-color-py.png");

    await openColor(COLOR.ruby, 1, COLOR_RUBY_LINES.length);
    const rbCol = await colorLook();
    check("不认得的语言（.rb）还是黑白：一个记号也没有、字跟原文一样",
        sameLines(rbCol, COLOR_RUBY_LINES) && rbCol.tokens === 0, JSON.stringify(rbCol.kinds));

    // 上色那条线以内的中等文件：照样上色（线是 384 KB 字符，这个 200 KB）
    await openColor(COLOR.mid, 3, COLOR_MID.lines);
    const midCol = JSON.parse(await page.eval(`
        return JSON.stringify({
            rows: window.__fileView().querySelectorAll(".file-line").length,
            tokens: window.__fileView().querySelectorAll(".file-text [class*='hljs-']").length,
        });
    `));
    check("上色那条线以内的中等文件（" + Math.round(COLOR_MID.text.length / 1024) + " KB）照样上色",
        midCol.rows === COLOR_MID.lines && midCol.tokens > 0, JSON.stringify(midCol));

    // 大文件：不上色（整段高亮 1.5 MB 要好几秒，会把页面卡在那儿），行号照旧、页面得答得上话。
    // 秒表先摆上再点：下面这条“最长卡住多久”的量就是这一下里最长的那个停顿。
    await startFreezeWatch();
    console.log("点文件链接：" + await clickLink(COLOR.big, 3));
    const bigCol = await waitLook("大到不上色的那个文件上来", (x) => x.rowCount === COLOR_BIG.lines, 30000);
    const bigFreeze = await readFreeze();
    const bigStats = JSON.parse(await page.eval(`
        const rows = window.__fileView().querySelectorAll(".file-line");
        const first = rows[0], last = rows[rows.length - 1];
        return JSON.stringify({
            rows: rows.length,
            tokens: window.__fileView().querySelectorAll(".file-text [class*='hljs-']").length,
            firstNum: first ? first.querySelector(".file-num").textContent : "",
            lastNum: last ? last.querySelector(".file-num").textContent : "",
            firstText: first ? first.querySelector(".file-text").textContent : "",
            lastText: last ? last.querySelector(".file-text").textContent : "",
            note: (window.__fileView().querySelector(".file-note") || {}).textContent || "",
        });
    `));
    check("大文件不上色（黑白、" + COLOR_BIG.lines + " 行都在、行号从 1 到最后一行都对）",
        bigStats.rows === COLOR_BIG.lines && bigStats.tokens === 0 && bigStats.note === ""
        && bigStats.firstNum === "1" && bigStats.lastNum === String(COLOR_BIG.lines)
        && bigStats.firstText === COLOR_UNIT.split("\n")[0],
        JSON.stringify({ rows: bigStats.rows, tokens: bigStats.tokens, first: bigStats.firstNum, last: bigStats.lastNum }));
    check("停在链接说的第 3 行", bigCol.hitNum === "3" && bigCol.hitVisible);
    check("大文件没把页面卡住（画这一下最长的停顿有上界；上色硬塞进来就会翻好几倍）",
        bigFreeze > 0 && bigFreeze < 2500, bigFreeze + "ms");
    await page.shot("file-25-color-big.png");
    // 这一大堆行别拖给后面的检查：关掉它那个标签
    console.log("点标签上的叉：" + await clickTab(COLOR.big, "close"));
    await page.sleep(300);

    // ==================== markdown：排好版渲染成文档 ====================
    // 认得的扩展名（.md / .mdx / .markdown）排好版渲染出来：标题按级别出、列表按列表出、
    // 代码块按代码块出，不留行号；链接里带的 `:12` 等于没带，也不报错。
    // 用的是消息流渲染正文那一套（renderMarkdown），不另起一套：代码块照样带语法高亮。
    // 扩展名不是 markdown 的（拿 .txt 盯着）照旧一行一行显示、带行号。
    const mdLook = async () => JSON.parse(await page.eval(`
        const body = window.__fileView();
        const doc = body.querySelector(".file-md");
        const heads = doc ? Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) : [];
        const pre = doc ? doc.querySelector("pre code") : null;
        const tabs = Array.from(document.querySelectorAll("#fileTabs .file-tab"));
        return JSON.stringify({
            hasDoc: !!doc,
            isMd: !!doc && doc.classList.contains("md"),
            rows: body.querySelectorAll(".file-line").length,
            nums: body.querySelectorAll(".file-num").length,
            heads: heads.map(function (h) { return [h.tagName, h.textContent]; }),
            ul: doc ? Array.from(doc.querySelectorAll("ul > li")).map(function (li) { return (li.textContent || "").trim(); }) : [],
            ol: doc ? Array.from(doc.querySelectorAll("ol > li")).map(function (li) { return (li.textContent || "").trim(); }) : [],
            preCount: doc ? doc.querySelectorAll("pre").length : 0,
            code: pre ? pre.textContent : "",
            codeTones: pre ? pre.querySelectorAll("span[class*='hljs-']").length : 0,
            quote: doc ? ((doc.querySelector("blockquote") || {}).textContent || "").trim() : "",
            text: doc ? (doc.textContent || "") : "",
            note: (body.querySelector(".file-note") || {}).textContent || "",
            links: doc ? Array.from(doc.querySelectorAll("a.file-link")).map(function (a) { return [a.getAttribute("data-file"), a.getAttribute("data-line") || ""]; }) : [],
            hitCount: body.querySelectorAll(".file-line.hit").length,
            tabPaths: tabs.map(function (t) { return t.getAttribute("data-path") || ""; }),
            activePath: (function () {
                const t = tabs.filter(function (x) { return x.classList.contains("active"); })[0];
                return t ? (t.getAttribute("data-path") || "") : "";
            })(),
            tabActive: tabs.findIndex(function (t) { return t.classList.contains("active"); }),
            // 「目录」那一格在第几位：它是哪一层取决于上一个检查段走到哪了，所以只盯“是不是第一个”，
            // 不盯它的 data-path（票 14 之后它会停在子目录上）。
            projIndex: tabs.findIndex(function (t) { return t.getAttribute("data-proj") === "1"; }),
        });
    `));

    console.log("点文件链接：" + await clickLink(MD.doc, MD.hit));
    const md1 = await waitLook("markdown 文档渲染上来", (x) => x.mdCount === 1, 15000);
    const mdDoc = await mdLook();
    check("点 markdown 链接：面板里排好版渲染成文档（标题按级别出）",
        mdDoc.hasDoc && mdDoc.isMd && mdDoc.heads.length === 2
        && mdDoc.heads[0][0] === "H1" && mdDoc.heads[0][1] === MD.h1
        && mdDoc.heads[1][0] === "H2" && mdDoc.heads[1][1] === MD.h2,
        JSON.stringify(mdDoc.heads));
    check("markdown 文档里的列表按列表出（无序三个、有序两个）",
        JSON.stringify(mdDoc.ul) === JSON.stringify(MD.items)
        && JSON.stringify(mdDoc.ol) === JSON.stringify(MD.ordered),
        JSON.stringify({ ul: mdDoc.ul, ol: mdDoc.ol }));
    check("markdown 文档里的代码块按代码块出（围栏记号没露出来、代码在里面）",
        mdDoc.preCount === 1 && mdDoc.code === MD.code + "\nconsole.log(a);\n"
        && mdDoc.text.indexOf("```") < 0,
        JSON.stringify({ pre: mdDoc.code }));
    check("markdown 文档里的引用按引用出", mdDoc.quote === MD.quote, mdDoc.quote);
    check("走的是消息流那一套渲染（代码块照样带语法高亮）", mdDoc.codeTones > 0, mdDoc.codeTones + " 个记号");
    check("markdown 不留行号（一行行那种格子与行号一个都没有）",
        mdDoc.rows === 0 && mdDoc.nums === 0 && md1.rowCount === 0 && md1.numCount === 0,
        JSON.stringify({ rows: mdDoc.rows, nums: mdDoc.nums }));
    check("链接里带的 :" + MD.hit + " 不生效、也不报错（没有点亮的那一行、也没有一句看不了的说明）",
        mdDoc.hitCount === 0 && mdDoc.note === "" && mdDoc.text.indexOf(MD.code) >= 0
        && md1.note === "" && md1.hitNum === "", JSON.stringify({ note: mdDoc.note }));
    check("markdown 文件照旧占一个标签",
        mdDoc.tabPaths[mdDoc.tabActive] === MD.doc && activeFilePath(mdDoc) === MD.doc && mdDoc.projIndex === 0,
        JSON.stringify({ active: mdDoc.tabActive, path: mdDoc.tabPaths[mdDoc.tabActive], proj: mdDoc.projIndex }));
    await page.shot("file-26-markdown.png");

    // 文档里写到的文件也是文件链接（消息流那一套渲染挂上去的）：点了开在这一列里，
    // 不是把页面卷走；顺带盯一眼别的文件照旧带行号。
    check("文档里写到的文件也是文件链接",
        JSON.stringify(mdDoc.links) === JSON.stringify([[MD.link, String(MD.linkLine)]]),
        JSON.stringify(mdDoc.links));
    console.log("点文档里的链接：" + await page.eval(`
        const a = window.__fileView().querySelector(".file-md a.file-link");
        if (!a) { return "没有这个链接"; }
        a.click();
        return "点了";
    `));
    const mdLink = await waitLook("文档里那条链接开出来的文件",
        (x) => x.rowCount === 5 && x.hitNum === String(MD.linkLine));
    check("点文档里的链接：那个文件开在这一列里（照旧带行号、停在链接说的那一行）",
        mdLink.mdCount === 0 && mdLink.numCount === 5 && mdLink.hitNum === String(MD.linkLine)
        && mdLink.hitText.indexOf("sample " + MD.linkLine) >= 0
        && mdLink.tabPaths[mdLink.tabActive] === MD.link,
        JSON.stringify({ rows: mdLink.rowCount, nums: mdLink.numCount, hit: mdLink.hitNum }));

    console.log("点文件链接：" + await clickLink(MD.plain, 2));
    const mdPlain = await waitLook("不是 markdown 的那个文件一行行上来",
        (x) => x.rowCount === MD_PLAIN_LINES.length && x.numCount === MD_PLAIN_LINES.length);
    check("扩展名不是 markdown 的：照旧一行一行、带行号（同样的记号不算标题也不算代码块）",
        mdPlain.mdCount === 0 && mdPlain.rowCount === MD_PLAIN_LINES.length
        && mdPlain.numCount === MD_PLAIN_LINES.length && mdPlain.firstRow.indexOf("# 这行不是标题") >= 0
        && mdPlain.hitNum === "2" && mdPlain.hitVisible,
        JSON.stringify({ rows: mdPlain.rowCount, nums: mdPlain.numCount, first: mdPlain.firstRow }));
    await page.shot("file-27-markdown-plain.png");
    // ==================== 折行开关：长行折起来，还是一行就是一行 ====================
    // 这一列角上那颗开关：「长行折起来」与「一行就是一行、横向滚」之间切，选的那个记在这台设备里
    //（跟「收没收起」同一个做法），刷新页面后还是刚才那样。
    console.log("点文件链接：" + await clickLink(FILE.wrap, WRAP_HIT));
    const wrap0 = await waitLook("那条超长行的文件上来",
        (x) => x.rowCount === WRAP_LINES && x.headRowLens[1] >= WRAP_LONG_CHARS);
    check("折行开关在面板角上（不在标签条里、也不在面板头里）",
        wrap0.wrapShown && wrap0.wrapInPanel && !wrap0.wrapInHeader && !wrap0.wrapInTabs
        && wrap0.wrapAtCorner && wrap0.wrapTop > wrap0.barBottom,
        JSON.stringify({ shown: wrap0.wrapShown, panel: wrap0.wrapInPanel, header: wrap0.wrapInHeader,
            tabs: wrap0.wrapInTabs, corner: wrap0.wrapAtCorner, top: wrap0.wrapTop, bar: wrap0.barBottom }));
    check("默认是「一行就是一行」：长行不折、正文横向滚得动",
        wrap0.whiteSpace === "pre" && wrap0.headRowHeights[1] === wrap0.headRowHeights[0] && wrap0.hScroll > 0,
        JSON.stringify({ ws: wrap0.whiteSpace, heights: wrap0.headRowHeights, hScroll: wrap0.hScroll }));
    await page.shot("file-26-wrap-off.png");

    console.log("点折行开关：" + await clickWrap());
    const wrap1 = await waitLook("长行折起来", (x) => x.whiteSpace === "pre-wrap");
    check("点一下开关：长行折起来（那一行占了好几行的高度）、横向不再滚",
        wrap1.headRowHeights[1] > wrap1.headRowHeights[0] * 3 && wrap1.hScroll === 0
        && wrap1.headRowLens[1] >= WRAP_LONG_CHARS,
        JSON.stringify({ heights: wrap1.headRowHeights, hScroll: wrap1.hScroll, lens: wrap1.headRowLens }));
    check("折起来以后字一个没少、行号也没乱（只是摆法换了）",
        wrap1.rowCount === WRAP_LINES && wrap1.headRowLens[1] >= WRAP_LONG_CHARS
        && wrap1.hitNum === String(WRAP_HIT) && wrap1.hitText.indexOf("超长的一行") >= 0,
        JSON.stringify(wrap1.headRowLens));
    check("开关看得出现在是折行的（按下去那个样子）", wrap1.wrapPressed === "true" && wrap1.wrapOnClass);
    await page.shot("file-27-wrap-on.png");

    // 开关管的是整块正文：换到另一个开着长行的文件，它也是折的
    console.log("点标签：" + await clickTab(COLOR.mid, "tab"));
    const wrapOther = await waitLook("换到 color-mid.ts 那个标签", (x) => x.rowCount === COLOR_MID.lines, 20000);
    check("折行管的是整块正文（换一个文件也照样折、横向不滚）",
        wrapOther.whiteSpace === "pre-wrap" && wrapOther.hScroll === 0,
        JSON.stringify({ ws: wrapOther.whiteSpace, hScroll: wrapOther.hScroll }));
    console.log("点标签：" + await clickTab(FILE.wrap, "tab"));
    const wrapBack = await waitLook("切回那条超长行", (x) => x.rowCount === WRAP_LINES);
    check("切回来还是折的（这个选择不跟着标签走）", wrapBack.whiteSpace === "pre-wrap" && wrapBack.hScroll === 0);

    // 刷新页面：选的那个还在（跟收没收起一个做法）
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await installFileView();
    await page.eval(POST_LINKS);
    await page.sleep(300);
    console.log("点文件链接：" + await clickLink(FILE.wrap, WRAP_HIT));
    const wrap2 = await waitLook("刷新之后长行还是折的",
        (x) => x.rowCount === WRAP_LINES && x.whiteSpace === "pre-wrap");
    check("刷新页面之后还是刚才那样（折行的选择记在这台设备里）",
        wrap2.whiteSpace === "pre-wrap" && wrap2.hScroll === 0
        && wrap2.headRowHeights[1] > wrap2.headRowHeights[0] * 3 && wrap2.wrapPressed === "true",
        JSON.stringify({ ws: wrap2.whiteSpace, heights: wrap2.headRowHeights }));

    console.log("点折行开关：" + await clickWrap());
    const wrap3 = await waitLook("长行又不折了", (x) => x.whiteSpace === "pre");
    check("再点一下开关：又变回「一行就是一行、横向滚」",
        wrap3.whiteSpace === "pre" && wrap3.hScroll > 0 && wrap3.headRowHeights[1] === wrap3.headRowHeights[0]
        && wrap3.wrapPressed === "false" && !wrap3.wrapOnClass,
        JSON.stringify({ ws: wrap3.whiteSpace, hScroll: wrap3.hScroll }));

    // 关掉的选择也记着：再刷新一遍还是「一行就是一行」
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await installFileView();
    await page.eval(POST_LINKS);
    await page.sleep(300);
    console.log("点文件链接：" + await clickLink(FILE.wrap, WRAP_HIT));
    const wrap4 = await waitLook("刷新之后长行还是横着滚",
        (x) => x.rowCount === WRAP_LINES && x.whiteSpace === "pre");
    check("关掉的选择也记得（刷新之后还是「一行就是一行」）",
        wrap4.whiteSpace === "pre" && wrap4.hScroll > 0 && wrap4.wrapPressed === "false"
        && wrap4.headRowHeights[1] === wrap4.headRowHeights[0]);
    await page.shot("file-28-wrap-remembered.png");

    // ==================== 直接打那条文件地址（拒绝的几种情形 + 条件请求）====================
    const raw = await page.eval(`
        const sid = (document.querySelector(".session-view:not(.off) .session-pane") || { dataset: {} }).dataset.sessionId || "";
        const get = async function (p, opts) {
            const o = opts || {};
            const session = o.session === undefined ? sid : o.session;
            let url = "/file?session=" + encodeURIComponent(session) + "&path=" + encodeURIComponent(p);
            if (o.mtime) { url += "&mtime=" + encodeURIComponent(o.mtime); }
            if (o.download) { url += "&download=1"; }
            const resp = await fetch(url);
            const buf = new Uint8Array(await resp.arrayBuffer());
            // 几 MB 的下载只核字节数与响应头，不转成文本：那种大小的字符串经调试接口回传，
            // 页面那边这条脚本就再也回不来了（整段卡住）。
            const text = buf.length > 64 * 1024 ? "" : new TextDecoder().decode(buf);
            return {
                status: resp.status, bytes: buf.length, mtime: resp.headers.get("x-file-mtime") || "",
                size: resp.headers.get("x-file-size") || "", type: resp.headers.get("content-type") || "",
                disposition: resp.headers.get("content-disposition") || "", text: text.trim(),
            };
        };
        return (async function () {
            const out = {};
            out.ok = await get(${JSON.stringify(FILE.long)});
            out.dotdot = await get("../../package.json");
            out.absolute = await get(${JSON.stringify(path.resolve(cwd, "..", "..", "package.json"))});
            out.outside = await get(${JSON.stringify(FILE.outside)});
            out.outsideDownload = await get(${JSON.stringify(FILE.outside)}, { download: true });
            out.missing = await get(${JSON.stringify(FILE.missing)});
            out.big = await get(${JSON.stringify(FILE.big)});
            out.bigBinary = await get(${JSON.stringify(FILE.bigBinary)});
            out.image = await get(${JSON.stringify(FILE.image)});
            out.bigImage = await get(${JSON.stringify(FILE.bigImage)});
            out.hugeImage = await get(${JSON.stringify(FILE.hugeImage)});
            out.binary = await get(${JSON.stringify(FILE.binary)});
            out.bigDownload = await get(${JSON.stringify(FILE.big)}, { download: true });
            out.binaryDownload = await get(${JSON.stringify(FILE.binary)}, { download: true });
            out.noSession = await get(${JSON.stringify(FILE.long)}, { session: "不存在的会话" });
            // 条件请求：拿上次那份的修改时间再问一次（该给空响应），换一个对不上的（该给正文）
            out.same = await get(${JSON.stringify(FILE.long)}, { mtime: out.ok.mtime });
            out.stale = await get(${JSON.stringify(FILE.long)}, { mtime: "1" });
            return JSON.stringify(out);
        })();
    `);
    const f = JSON.parse(raw);
    console.log("直接打那条地址：" + JSON.stringify({
        ok: f.ok.status, dotdot: f.dotdot.status, absolute: f.absolute.status, outside: f.outside.status,
        missing: f.missing.status, big: f.big.status, noSession: f.noSession.status,
        image: f.image.status, binary: f.binary.status, bigDownload: f.bigDownload.status, bigDownloadBytes: f.bigDownload.bytes,
    }));
    check("地址能取到内容（200、按 UTF-8 的正文）",
        f.ok.status === 200 && f.ok.text.split("\n").length === LONG_LINES && f.ok.text.indexOf("第 " + HIT_LINE + " 行") >= 0);
    check("用 .. 绕出去的写法：403", f.dotdot.status === 403 && f.dotdot.text.indexOf("会话目录外") >= 0);
    check("写成绝对路径且在外面：403", f.absolute.status === 403);
    check("软链接指到目录外：403", f.outside.status === 403);
    check("下载那条路也照样看边界（目录外不给）", f.outsideDownload.status === 403, String(f.outsideDownload.status));
    check("文件不存在：404", f.missing.status === 404);
    check("超过 2 MB：413、响应里带着字节数",
        f.big.status === 413 && f.big.text.indexOf(String(BIG_BYTES)) >= 0 && f.big.size === String(BIG_BYTES),
        JSON.stringify({ text: f.big.text, size: f.big.size }));
    check("图片按图片类型给出来（Content-Type 是 PNG，字节就是那张图）",
        f.image.status === 200 && f.image.type.indexOf("image/png") === 0 && f.image.bytes > 1000 && f.image.mtime !== "",
        JSON.stringify({ status: f.image.status, type: f.image.type, bytes: f.image.bytes }));
    check("超过 2 MB 的图片：照样直接给（图片自己的上限是 20 MB）",
        f.bigImage.status === 200 && f.bigImage.type.indexOf("image/png") === 0
        && f.bigImage.bytes > 2 * 1024 * 1024,
        JSON.stringify({ status: f.bigImage.status, type: f.bigImage.type, bytes: f.bigImage.bytes }));
    check("超过 20 MB 的图片：413、响应里带着字节数",
        f.hugeImage.status === 413 && f.hugeImage.size === String(HUGE_IMAGE_BYTES),
        JSON.stringify({ status: f.hugeImage.status, size: f.hugeImage.size }));
    check("二进制文件要当正文看：415、一句说明，内容不给",
        f.binary.status === 415 && f.binary.text.indexOf("二进制") >= 0 && f.binary.size === String(BINARY_BYTES),
        JSON.stringify({ status: f.binary.status, size: f.binary.size, text: f.binary.text }));
    check("超过 2 MB 的二进制文件：先说「太大」（413），不说「二进制」",
        f.bigBinary.status === 413 && f.bigBinary.text.indexOf("太大") >= 0 && f.bigBinary.size === String(BIG_BYTES),
        JSON.stringify({ status: f.bigBinary.status, size: f.bigBinary.size, text: f.bigBinary.text }));
    check("下载那条路不受 2 MB 限制：几 MB 的文件整份下来、按附件给名字",
        f.bigDownload.status === 200 && f.bigDownload.bytes === BIG_BYTES
        && f.bigDownload.type.indexOf("application/octet-stream") === 0
        && f.bigDownload.disposition.indexOf("attachment") === 0 && f.bigDownload.disposition.indexOf(FILE.big) >= 0,
        JSON.stringify({ status: f.bigDownload.status, bytes: f.bigDownload.bytes, want: BIG_BYTES, type: f.bigDownload.type, cd: f.bigDownload.disposition }));
    check("下载不受限那条也管小文件（二进制整份下来）",
        f.binaryDownload.status === 200 && f.binaryDownload.bytes === BINARY_BYTES);
    check("不认识的会话：不给内容", f.noSession.status !== 200);
    check("回话里带着这份内容的修改时间（页面下次带它回来问）",
        f.ok.status === 200 && f.ok.mtime !== "", f.ok.mtime);
    check("带着同一个修改时间再问：空响应（正文不重复传）",
        f.same.status === 204 && f.same.text === "", JSON.stringify({ status: f.same.status, len: f.same.text.length }));
    check("修改时间对不上：给正文",
        f.stale.status === 200 && f.stale.text.split("\n").length === LONG_LINES);

    // ==================== 直接打那条目录地址 ====================
    const rawDir = JSON.parse(await page.eval(`
        const sid = (document.querySelector(".session-view:not(.off) .session-pane") || { dataset: {} }).dataset.sessionId || "";
        const get = async function (p, session) {
            const s = session === undefined ? sid : session;
            const resp = await fetch("/dir?session=" + encodeURIComponent(s) + "&path=" + encodeURIComponent(p));
            const text = await resp.text();
            let body = null;
            try { body = JSON.parse(text); } catch (e) { body = null; }
            return { status: resp.status, type: resp.headers.get("content-type") || "", text: text.trim(), body: body };
        };
        return (async function () {
            const out = {};
            out.top = await get(${JSON.stringify(DIR.top)});
            out.sub = await get(${JSON.stringify(DIR.sub)});
            out.empty = await get(${JSON.stringify(DIR.empty)});
            out.huge = await get(${JSON.stringify(DIR.huge)});
            out.file = await get(${JSON.stringify(FILE.sample)});
            out.missing = await get("没有这个目录");
            out.dotdot = await get("../../");
            out.absolute = await get(${JSON.stringify(path.resolve(cwd, "..", ".."))});
            out.outside = await get("outside");
            out.outLink = await get(${JSON.stringify(DIR.outLink)});
            out.noSession = await get(${JSON.stringify(DIR.top)}, "不存在的会话");
            return JSON.stringify(out);
        })();
    `));
    const entriesOf = (r) => (r.body && Array.isArray(r.body.entries) ? r.body.entries : []);
    const names = (r) => entriesOf(r).map((e) => e.name);
    console.log("直接打那条目录地址：" + JSON.stringify({
        top: rawDir.top.status, sub: rawDir.sub.status, empty: rawDir.empty.status, file: rawDir.file.status,
        missing: rawDir.missing.status, dotdot: rawDir.dotdot.status, absolute: rawDir.absolute.status,
        outside: rawDir.outside.status, outLink: rawDir.outLink.status, noSession: rawDir.noSession.status,
    }));
    check("目录地址给的是一份清单（JSON，列出了里面的东西）",
        rawDir.top.status === 200 && rawDir.top.type.indexOf("application/json") === 0
        && JSON.stringify(names(rawDir.top)) === JSON.stringify(DIR_TOP_NAMES),
        JSON.stringify({ status: rawDir.top.status, type: rawDir.top.type, names: names(rawDir.top) }));
    check("清单里每项说得出名字、相对写法、是不是目录",
        names(rawDir.top).length === DIR_TOP_NAMES.length && entriesOf(rawDir.top).every((e) =>
            typeof e.name === "string" && typeof e.path === "string"
            && e.path.indexOf(DIR.top + "/") === 0 && typeof e.dir === "boolean")
        && entriesOf(rawDir.top)[0].dir === true && entriesOf(rawDir.top)[4].dir === false,
        JSON.stringify(entriesOf(rawDir.top).map((e) => [e.path, e.dir])));
    const topEntries = entriesOf(rawDir.top);
    const thumbEntry = topEntries.find((e) => e.name === "pic.png");
    const bigEntry = topEntries.find((e) => e.name === "big.png");
    check("清单里的文件带着字节数，图片还带着 image 标记（页面据此挂缩略图）",
        !!thumbEntry && thumbEntry.size > 0 && thumbEntry.image === true
        && !!bigEntry && bigEntry.size > 2 * 1024 * 1024 && bigEntry.image === true
        && topEntries.filter((e) => !e.dir).every((e) => typeof e.size === "number")
        && topEntries.filter((e) => e.dir).every((e) => e.size === undefined && e.image === undefined),
        JSON.stringify(topEntries.map((e) => [e.path, e.size, e.image])));
    check("清单里那颗指到目录外的软链接照样列出来（点它才挡）",
        entriesOf(rawDir.top).some((e) => e.name === "out" && e.dir === true));
    check("子目录列得出下一层", rawDir.sub.status === 200 && entriesOf(rawDir.sub).length === 1
        && entriesOf(rawDir.sub)[0].name === "three.js" && entriesOf(rawDir.sub)[0].path === DIR.subFile);
    check("空目录：列出来是空的", rawDir.empty.status === 200 && entriesOf(rawDir.empty).length === 0);
    check("目录里东西太多：只列前 " + DIR_MAX_ENTRIES + " 个、说一声截断了",
        rawDir.huge.status === 200 && entriesOf(rawDir.huge).length === DIR_MAX_ENTRIES
        && rawDir.huge.body.truncated === true && names(rawDir.huge)[0] === "f000.txt"
        && names(rawDir.huge)[DIR_MAX_ENTRIES - 1] === "f499.txt",
        JSON.stringify({ count: entriesOf(rawDir.huge).length, truncated: rawDir.huge.body && rawDir.huge.body.truncated }));
    check("拿文件当目录列：404", rawDir.file.status === 404, String(rawDir.file.status));
    check("目录不存在：404", rawDir.missing.status === 404);
    check("用 .. 绕出去的写法：403", rawDir.dotdot.status === 403 && rawDir.dotdot.text.indexOf("会话目录外") >= 0);
    check("写成绝对路径且在外面：403", rawDir.absolute.status === 403);
    check("软链接指到目录外：403", rawDir.outside.status === 403 && rawDir.outLink.status === 403,
        JSON.stringify({ outside: rawDir.outside.status, outLink: rawDir.outLink.status }));
    check("不认识的会话：不给清单", rawDir.noSession.status !== 200, String(rawDir.noSession.status));

    // ==================== 光名字 / 路径写岔了：按名字找（会话碰过的、以及会话目录里找一圈）====================
    // 链接里只有一个光名字（`only-name.js` 这种）、或者路径写岔了时：后端先按会话目录拼；拼不到，
    // 就在这个会话碰过的文件（read / edit / write 过的，后端有这份清单）里按文件名匹配；还拼不到，
    // 就在会话目录里按名字找一圈（不进 node_modules 这些目录，有定额）；三档都找不到才说
    //「没有这个文件」；匹配到的东西仍然必须在会话目录以内。那份清单来自 pi 的工具调用，
    // 所以先让假 pi 读几个特意铺好的文件（见 prepareNameFixtures 与 fakePi.js 的「碰文件」那段）。
    console.log("让假 pi 读几个文件（喂「这个会话碰过的文件」清单）…");
    await page.send("碰文件：读几个文件，把清单喂给后端。");
    await page.waitText("读完了。");
    await page.sleep(400);
    await page.eval(`for (const m of ${JSON.stringify([{ type: "assistantFull", text: NAME_LINK_TEXT }])}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(400);
    check("光名字那几个链接出现在消息流里",
        (await page.eval(`
            const want = ${JSON.stringify([NAME.bare, NAME.wrong, NAME.both])};
            return Array.from(document.querySelectorAll("a.file-link"))
                .filter(function (a) { return want.indexOf(a.getAttribute("data-file")) >= 0; }).length;
        `)) === 3);

    // 光名字：会话目录里没有这个名字，靠那份清单找到子目录里那个
    console.log("点文件链接：" + await clickLink(NAME.bare, NAME_HIT));
    const named = await waitLook("光名字链接打开子目录里那个文件",
        (x) => activeFilePath(x) === NAME.bare && x.rowCount === NAME_LINES.length);
    check("链接里只有光名字：按会话目录拼接不到，在会话碰过的文件里按名字找到它、打开",
        named.rowCount === NAME_LINES.length && named.note === "" && named.hitNum === String(NAME_HIT)
        && named.hitText.indexOf("only-name 第 " + NAME_HIT + " 行") >= 0
        && named.firstRow.indexOf("only-name 第 1 行") >= 0,
        JSON.stringify({ title: named.title, rows: named.rowCount, hit: named.hitNum, note: named.note }));
    await page.shot("file-26-bare-name.png");

    // 路径写岔了：那个目录根本不存在，一样按文件名匹配到它
    console.log("点文件链接：" + await clickLink(NAME.wrong, NAME_HIT));
    const namedWrong = await waitLook("路径写岔了也打开那个文件",
        (x) => activeFilePath(x) === NAME.wrong && x.rowCount === NAME_LINES.length);
    check("路径写岔了（那个目录不存在）：一样按文件名匹配到它",
        namedWrong.rowCount === NAME_LINES.length && namedWrong.note === ""
        && namedWrong.hitText.indexOf("only-name 第 " + NAME_HIT + " 行") >= 0,
        JSON.stringify({ title: namedWrong.title, rows: namedWrong.rowCount, note: namedWrong.note }));

    // 会话目录里也有那个名字：先按会话目录拼（清单里那一份不该赢）
    console.log("点文件链接：" + await clickLink(NAME.both, 1));
    const namedBoth = await waitLook("两层都有那个名字：拿会话目录这一份",
        (x) => activeFilePath(x) === NAME.both && x.rowCount === NAME_BOTH_LINES.length);
    check("会话目录里与清单里都有那个名字：先按会话目录拼（会话目录这一份赢）",
        namedBoth.rowCount === NAME_BOTH_LINES.length && namedBoth.firstRow.indexOf("会话目录这一份 1") >= 0
        && namedBoth.note === "",
        JSON.stringify({ rows: namedBoth.rowCount, first: namedBoth.firstRow }));

    // 清单里那个文件真身在外面：匹配到了也不给看
    console.log("点文件链接：" + await clickLink(NAME.outside, 1));
    const namedOut = await waitLook("光名字匹配到会话目录外面的文件",
        (x) => activeFilePath(x) === NAME.outside && x.note.indexOf("会话目录外") >= 0);
    check("光名字匹配到会话目录外面的文件：不给看，一句「会话目录外」",
        namedOut.rowCount === 0 && namedOut.note.indexOf("会话目录外") >= 0, namedOut.note);

    // 第三档（会话里没人碰过这个名字）：在会话目录里按名字找一圈
    console.log("点文件链接：" + await clickLink(NAME.byName, 1));
    const namedByName = await waitLook("会话没碰过的光名字也在子目录里找到",
        (x) => activeFilePath(x) === NAME.byName && x.rowCount === NAME_BY_NAME_LINES.length);
    check("会话里没人碰过这个名字：在会话目录里按名字找到它（深浅两层同名，浅的那一层赢）",
        namedByName.rowCount === NAME_BY_NAME_LINES.length && namedByName.note === ""
        && namedByName.firstRow.indexOf("deep 里这一份 1") >= 0,
        JSON.stringify({ rows: namedByName.rowCount, first: namedByName.firstRow, note: namedByName.note }));

    // 但那一档不进去 node_modules 这类目录：那里面的名字跟没找到一样
    console.log("点文件链接：" + await clickLink(NAME.skipped, 1));
    const namedSkipped = await waitLook("藏在 node_modules 里的那个名字找不到",
        (x) => activeFilePath(x) === NAME.skipped && x.note.indexOf("没有这个文件") >= 0);
    check("只在 node_modules 里有的名字：按名字找那一档不进去那些目录，按找不到算",
        namedSkipped.rowCount === 0 && namedSkipped.note.indexOf("没有这个文件") >= 0, namedSkipped.note);

    // 三档都找不到：跟票 01 那句一样
    console.log("点文件链接：" + await clickLink(NAME.absent, 1));
    const namedAbsent = await waitLook("三档都找不到那个文件",
        (x) => activeFilePath(x) === NAME.absent && x.note.indexOf("没有这个文件") >= 0);
    check("目录里没有、会话也没碰过、按名字也找不到：给一句「没有这个文件」",
        namedAbsent.rowCount === 0 && namedAbsent.note.indexOf("没有这个文件") >= 0, namedAbsent.note);

    // 直接打那条地址，把三档的状态与正文核一遍（这一列上看到的就是它）
    const rawName = JSON.parse(await page.eval(`
        const sid = (document.querySelector(".session-view:not(.off) .session-pane") || { dataset: {} }).dataset.sessionId || "";
        const get = async function (p) {
            const resp = await fetch("/file?session=" + encodeURIComponent(sid) + "&path=" + encodeURIComponent(p));
            const text = await resp.text();
            return { status: resp.status, text: text.trim() };
        };
        return (async function () {
            const out = {};
            out.bare = await get(${JSON.stringify(NAME.bare)});
            out.bareFile = await get(${JSON.stringify(NAME.bareFile)});
            out.wrong = await get(${JSON.stringify(NAME.wrong)});
            out.both = await get(${JSON.stringify(NAME.both)});
            out.bothDeep = await get(${JSON.stringify(NAME.bothDeep)});
            out.outside = await get(${JSON.stringify(NAME.outside)});
            out.absent = await get(${JSON.stringify(NAME.absent)});
            out.byName = await get(${JSON.stringify(NAME.byName)});
            out.skipped = await get(${JSON.stringify(NAME.skipped)});
            return JSON.stringify(out);
        })();
    `));
    console.log("直接打那条地址（光名字那几档）：" + JSON.stringify({
        bare: rawName.bare.status, bareFile: rawName.bareFile.status, wrong: rawName.wrong.status,
        both: rawName.both.status, bothDeep: rawName.bothDeep.status,
        outside: rawName.outside.status, absent: rawName.absent.status,
        byName: rawName.byName.status, skipped: rawName.skipped.status,
    }));
    check("光名字：地址也直接给内容（就是子目录里那一份，六行一字不差）",
        rawName.bare.status === 200 && rawName.bare.text.split("\n").length === NAME_LINES.length
        && rawName.bare.text === NAME_LINES.join("\n"),
        JSON.stringify({ status: rawName.bare.status }));
    check("路径写岔了、以及按清单里那份相对写法打：都给同一个文件",
        rawName.wrong.status === 200 && rawName.wrong.text === NAME_LINES.join("\n")
        && rawName.bareFile.status === 200 && rawName.bareFile.text === NAME_LINES.join("\n"),
        JSON.stringify({ wrong: rawName.wrong.status, list: rawName.bareFile.status }));
    check("会话目录里也有那个名字：地址先按会话目录拼（会话目录这一份）",
        rawName.both.status === 200 && rawName.both.text === NAME_BOTH_LINES.join("\n")
        && rawName.bothDeep.status === 200 && rawName.bothDeep.text === NAME_BOTH_DEEP_LINES.join("\n"),
        JSON.stringify({ both: rawName.both.status }));
    check("匹配到的文件真身在外面：403、不把内容给出去",
        rawName.outside.status === 403 && rawName.outside.text.indexOf("会话目录外") >= 0,
        JSON.stringify({ status: rawName.outside.status, text: rawName.outside.text }));
    check("会话里没人碰过的名字：地址也直接给内容（浅的那一层）",
        rawName.byName.status === 200 && rawName.byName.text === NAME_BY_NAME_LINES.join("\n"),
        JSON.stringify({ status: rawName.byName.status, text: rawName.byName.text }));
    check("只在 node_modules 里有的名字：地址也按找不到算（不进去那些目录）",
        rawName.skipped.status === 404 && rawName.skipped.text.indexOf("没有这个文件") >= 0,
        JSON.stringify({ status: rawName.skipped.status, text: rawName.skipped.text }));
    check("三档都找不到：404、一句「没有这个文件」",
        rawName.absent.status === 404 && rawName.absent.text.indexOf("没有这个文件") >= 0,
        JSON.stringify({ status: rawName.absent.status, text: rawName.absent.text }));

    // ==================== 切会话：「目录」换成新会话的目录、文件标签清空 ====================
    // 真开一个新会话（会话目录就是 dirA，跟当前这个会话的目录不一样）：走的是后端真会话编排，
    // 消息形状与后端推的那份一样，所以下面几条真会话的检查放在它后面。
    const otherDir = path.join(cwd, DIR.top);
    // 切之前先把「目录」那一格走到某一层子目录里：切过去以后该回到新会话的目录本身
    console.log("点目录链接：" + await clickDir(DIR.sub));
    const dirBeforeSwitch = await waitLook("切会话之前先走进子目录",
        (x) => x.entryCount === 1 && x.tabActive === x.projIndex);
    check("切会话之前：「目录」那一格已经走到子目录里",
        dirBeforeSwitch.tabPaths[dirBeforeSwitch.projIndex] === DIR.sub
        && headOk(dirBeforeSwitch, cwd, DIR.sub), JSON.stringify({ hover: projTitle(dirBeforeSwitch) }));
    check("切会话之前面板里开着好几个标签", (await look("切会话之前")).tabCount >= 2);
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(path.join(cwd, DIR.top))} });
        return true;
    `);
    const switched = await waitLook("切到新会话、目录换成新目录", (x) => x.tabCount === 1 && x.projIndex === 0
        && x.tabActive === 0 && x.entryCount === DIR_TOP_NAMES.length && samePathText(x.tabTitles[x.projIndex], otherDir), 15000);
    check("切会话：面板还开着、里面只剩「目录」那一格（上一个会话的文件标签清掉了）",
        switched.open && switched.tabCount === 1 && switched.projCount === 1 && switched.projIndex === 0,
        JSON.stringify({ count: switched.tabCount, names: switched.tabNames }));
    check("切会话：那一格换成新会话的目录（悬停提示是新路径）",
        samePathText(projTitle(switched), otherDir),
        JSON.stringify({ hover: projTitle(switched), want: otherDir }));
    check("切会话：那一格回到新会话的目录本身（不记住上一个会话走到哪一层）",
        switched.tabPaths[switched.projIndex] === "." && !switched.upShown,
        JSON.stringify({ path: switched.tabPaths[switched.projIndex], up: switched.upShown }));
    check("切会话：列的是新会话目录里的东西（不是上一个会话那份）",
        JSON.stringify(switched.entryNames.map(function (n) { return n.replace(/\/$/, ""); })) === JSON.stringify(DIR_TOP_NAMES),
        JSON.stringify(switched.entryNames));
    check("切会话：上一个会话的文件内容也不留在面板里", switched.rowCount === 0 && switched.note === "");
    await page.shot("file-10-session-switch.png");

    // 再切回原来那个会话：它自己那一份标签原样回来（每个会话各记一份，见 chat.js 的 resetFileSidebarForSession）
    // 这趟跑的是网页端，切会话走它自己那条消息（跟顶条下拉框、面板里点一行是同一件事）
    console.log("切回原来那个会话：" + await page.eval(`
        acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(sessionInfo.sessionId)} });
        return "说了";
    `));
    const backSession = await waitLook("切回原来那个会话、它那一份标签摆回来",
        (x) => x.tabCount >= 2 && x.projIndex === 0 && x.tabPaths[x.projIndex] === DIR.sub, 15000);
    check("切回原来那个会话：它开过的标签原样回来了（「目录」那一格走到哪一层也记着）",
        backSession.tabCount >= 2 && backSession.tabPaths[backSession.projIndex] === DIR.sub,
        JSON.stringify({ count: backSession.tabCount, paths: backSession.tabPaths }));
    check("切回来摆上的是它当时看着的那一格",
        backSession.tabActive >= 0 && backSession.tabActive < backSession.tabCount
        && backSession.activePath !== "",
        JSON.stringify({ active: backSession.tabActive, path: backSession.activePath }));
    await page.shot("file-10b-session-back.png");

    // ==================== 宽度：能拖、记在这台设备里、上下限跟着窗口走；手机上铺满 ====================
    // 这一段会把拖出来的宽度记进本机、还会开一下触摸模拟，所以摆在最后（网页视图那一趟不看宽度）。
    // 上面那些检查都是在「没拖过 = 默认 360」这个状态下跑的。
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const wz0 = await look("宽度 · 起点");
    if (!wz0.open) { await page.click("#fileSidebarBtn"); await page.sleep(400); }
    const wz1 = await look("宽度 · 没拖过");
    check("没拖过时就是默认宽度 " + FILE_W_DEFAULT + "px（对话正好让出这么多）",
        wz1.open && wz1.dock && wz1.panelWidth === FILE_W_DEFAULT && wz1.chatLeft === FILE_W_DEFAULT
        && wz1.fileVar === FILE_W_DEFAULT + "px" && wz1.storedW === null,
        JSON.stringify({ w: wz1.panelWidth, chat: wz1.chatLeft, v: wz1.fileVar, stored: wz1.storedW }));
    check("常驻时那条缝在（就贴在这一列的右边，不在别处）", wz1.resizeShown && wz1.resizeAtEdge);
    check("那条缝的右边没压到输入框上（探进对话那边那几像素落在内边距里）",
        wz1.resizeRight !== null && wz1.resizeRight <= 0, String(wz1.resizeRight));
    check("这会儿还不是手机上那种铺满", !wz1.full && !wz1.touch);

    // 指针移到那条缝上：底下那条分隔线亮起来（不新增看得见的东西）
    const edgeIdle = await edgeLine();
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: FILE_W_DEFAULT, y: 400, button: "none" });
    await page.sleep(250);
    const edgeHot = await edgeLine();
    check("指针不在上面时那条线是淡的（热区本身看不见）", /rgba?\(0, 0, 0, 0\)|transparent/.test(edgeIdle), edgeIdle);
    check("指针移到那条缝上：那条分隔线亮起来",
        edgeHot !== edgeIdle && !/rgba?\(0, 0, 0, 0\)|transparent/.test(edgeHot),
        JSON.stringify({ idle: edgeIdle, hot: edgeHot }));
    await page.shot("file-15c-width-hover.png");
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 620, y: 200, button: "none" });
    await page.sleep(200);
    await page.shot("file-15-width-default.png");

    // 拖到 700：拖着就在变、松手就落定、记进本机
    const wzDrag1 = JSON.parse(await dragEdge(FILE_W_DEFAULT, 700));
    await page.sleep(250);
    const wz2 = await look("宽度 · 拖到 700");
    check("拖着的时候就在变（不是松手才变）", wzDrag1.midWidth === 700 && wzDrag1.midClass, JSON.stringify(wzDrag1));
    check("拖动中只有这一列在动，对话那边先冻着（它一动就是整屏消息重新排字，长会话很贵）",
        wzDrag1.midChatLeft === FILE_W_DEFAULT,
        JSON.stringify({ 拖动中对话左边缘: wzDrag1.midChatLeft, 拖动前: FILE_W_DEFAULT }));
    check("松手之后这一列就是 700，对话才跟着排过去（就这一次）",
        wz2.panelWidth === 700 && wz2.chatLeft === 700 && wzDrag1.chatLeft === 700,
        JSON.stringify({ panel: wz2.panelWidth, chat: wz2.chatLeft }));
    check("拖动中那两颗类（光标 / 不许选字）收干净了", wzDrag1.afterClass === false && wz2.full === false);
    check("松手那一下记进了本机", wzDrag1.stored === "700" && wz2.storedW === "700",
        JSON.stringify({ ev: wzDrag1.stored, dom: wz2.storedW }));

    // 上限：不是死板的 1200，而是「窗口宽度 − 360」（1280 的窗口下就是 920）
    const cap1280 = fileWCap(1280);
    await dragEdge(700, 2000);
    await page.sleep(250);
    const wz3 = await look("宽度 · 往右拖到底");
    check("往右拖到底：夹在「窗口宽度 − 360」＝" + cap1280 + "（对话那边留得住）",
        wz3.panelWidth === cap1280 && wz3.chatLeft === cap1280, JSON.stringify({ w: wz3.panelWidth, want: cap1280 }));
    check("拖到底记下的也是这个数", wz3.storedW === String(cap1280), String(wz3.storedW));

    // 下限：往左拖到底夹在 300
    await dragEdge(cap1280, 50);
    await page.sleep(250);
    const wz4 = await look("宽度 · 往左拖到底");
    check("往左拖到底：夹在 " + FILE_W_MIN + "，再窄就没有了",
        wz4.panelWidth === FILE_W_MIN && wz4.chatLeft === FILE_W_MIN, String(wz4.panelWidth));
    check("拖到底记下的也是这个数", wz4.storedW === String(FILE_W_MIN), String(wz4.storedW));
    check("拖到最窄：这一列里那颗「收起」的叉还没被挤出去、标签条也还在",
        wz4.tabShown && wz4.closeInside, JSON.stringify({ tabs: wz4.tabShown, close: wz4.closeInside }));
    await page.shot("file-15b-width-min.png");

    // 再拖回 920：这就是后面要验的「记住的那个数」
    await dragEdge(FILE_W_MIN, 2000);
    await page.sleep(250);
    check("再拖回上限那个数", (await look("宽度 · 拖回上限")).panelWidth === cap1280);

    // 窗口变窄：上限跟着收，但存的那个值一个字都不动（拉回来自己就回到拖的那个数）
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const wz5 = await look("宽度 · 窗口缩到 1200");
    check("窗口缩到 1200：常驻还在，宽度跟着收到 " + fileWCap(1200),
        wz5.dock && wz5.panelWidth === fileWCap(1200) && wz5.chatLeft === fileWCap(1200),
        JSON.stringify({ w: wz5.panelWidth, want: fileWCap(1200) }));
    check("窗口变窄没有把人存的那个值改掉", wz5.storedW === String(cap1280),
        JSON.stringify({ stored: wz5.storedW, want: String(cap1280) }));
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const wz6 = await look("宽度 · 窗口拉回 1280");
    check("窗口拉回来：这一列自己就回到拖的那个数", wz6.panelWidth === cap1280, String(wz6.panelWidth));
    await page.shot("file-16-width-dragged.png");

    // 刷新：拖出来的宽度记在这台设备里
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(600);
    const wz7 = await look("宽度 · 刷新之后");
    check("刷新之后还是拖出来的那个宽度", wz7.open && wz7.dock && wz7.panelWidth === cap1280,
        JSON.stringify({ w: wz7.panelWidth, want: cap1280 }));

    // 滑入式（窗口 <1200）：那条缝不给拖，宽度就是这个数跟「窗口的 86%」里小的那个
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const drawerWant = Math.min(cap1280, Math.round(1000 * 0.86));
    const wz8 = await look("宽度 · 滑入式（1000px 的窗口）");
    check("窗口不够宽：又变回滑入式（底下垫着那层遮罩）", !wz8.dock && wz8.open && wz8.backdropShown);
    check("滑入式里那条缝不给拖（它就不显示）", !wz8.resizeShown);
    check("滑入式里宽度就是拖出来的那个数（最多到窗口的 86%）",
        wz8.panelWidth === drawerWant, JSON.stringify({ w: wz8.panelWidth, want: drawerWant }));
    await dragEdge(drawerWant, 300);
    await page.sleep(250);
    const wz9 = await look("宽度 · 滑入式里想拖一下");
    check("滑入式里拖了也白拖（宽度跟存的那个数都没动）",
        wz9.panelWidth === drawerWant && wz9.storedW === String(cap1280),
        JSON.stringify({ w: wz9.panelWidth, stored: wz9.storedW }));

    // 手机（触屏）：滑出来铺满整屏，收起靠头上那颗叉——那条「点外面」的路被盖住了
    //（触屏是页面加载时认一次的，所以先把模拟打开再刷新）
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(600);
    const wza = await look("手机 · 起点");
    if (!wza.open) { await page.click("#fileSidebarBtn"); await page.sleep(400); }
    const wzb = await look("手机 · 滑出来");
    check("手机上认得出这是触屏", wzb.touch);
    check("手机上这一层铺满整屏（右边不再漏一条能点外面收起的边）",
        wzb.open && !wzb.dock && wzb.full && wzb.panelWidth === 420,
        JSON.stringify({ w: wzb.panelWidth, vw: wzb.vw, full: wzb.full }));
    check("铺满时最右边那一点也被这一列盖住了（不再是底下那层遮罩）",
        wzb.topAtRight !== "fileBackdrop" && wzb.topAtRight !== "",
        JSON.stringify({ right: wzb.topAtRight, chat: wzb.topAtChat }));
    check("铺满时也不给拖（那条缝不显示）", !wzb.resizeShown);
    check("手机上铺满不会把电脑上拖出来的宽度改掉", wzb.storedW === String(cap1280), String(wzb.storedW));
    await page.shot("file-17-phone-full.png");

    await page.click("#fileClose");
    await page.sleep(300);
    const wzc = await look("手机 · 点头上那颗叉");
    check("手机上就靠头上那颗叉收起（点了就收、铺满那颗类也摘了）", !wzc.open && !wzc.full,
        JSON.stringify({ open: wzc.open, full: wzc.full }));

    // 把这台设备又摆回电脑（后面的检查当没这回事）
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(400);

    // ==================== 插件里的对话面板：这一列与这颗按钮都不该有 ====================
    // 在页面脚本里先塞一个网页视图接口（真 VSCode 里本来就有这个函数），界面就会按
    // “插件里的对话面板”那套跑起来；然后重新加载页面看区别。
    // 剩下这一趟都按网页视图跑，所以放在最后。
    await page.eval(`
        window.__sentToHost = [];
        return true;
    `);
    await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            window.__sentToHost = [];
            window.acquireVsCodeApi = function () {
                return {
                    postMessage: function (m) { window.__sentToHost.push(m); },
                    getState: function () { return null; },
                    setState: function () {},
                };
            };
        `,
    });
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await installFileView();
    // 没有推送通道，界面得自己喂一份会话列表；下面这条消息的内容按后端真正推的那份写。
    await page.eval(`
        window.postMessage({ type: "sessionList", sessions: [{
            id: ${JSON.stringify(sessionInfo.sessionId)}, name: "测试会话", streaming: false, activity: "idle",
            piReady: true, modelId: "fake", provider: "fake", cwd: ${JSON.stringify(cwd)},
        }] }, "*");
        return true;
    `);
    await page.sleep(300);
    const view0 = await look("按插件里的对话面板跑：");
    check("插件里的对话面板里没有这一列", !view0.hasPanel);
    check("插件里的对话面板里没有这颗按钮", !view0.hasButton);
    await page.eval(`window.postMessage({ type: "assistantFull", text: ${JSON.stringify(LINK_TEXT)}, sessionId: ${JSON.stringify(sessionInfo.sessionId)} }, "*"); return true;`);
    await page.sleep(400);
    const viewDir = JSON.parse(await page.eval(`
        return JSON.stringify({
            dirLinks: document.querySelectorAll("a.file-link[data-dir]").length,
            text: (document.getElementById("messages") || {}).textContent || "",
        });
    `));
    check("插件里的对话面板里目录写法还是普通文字（不变成链接、也就不会给编辑器发一条开目录的消息）",
        viewDir.dirLinks === 0 && viewDir.text.indexOf(DIR.top + "/") >= 0 && viewDir.text.indexOf(DIR.sub + "/") >= 0,
        "目录链接 " + viewDir.dirLinks + " 个");
    await page.sleep(400);
    const panelLink = await page.eval(`return document.querySelectorAll("a.file-link").length`);
    await clickLink(FILE.long);
    await page.sleep(500);
    const sent = JSON.parse(await page.eval(`return JSON.stringify((window.__sentToHost || []).filter(function (m) { return m && m.type === "openFile"; }));`));
    check("插件里的对话面板里点链接照旧交给编辑器打开", panelLink >= 5 && sent.length === 1 && sent[0].path === FILE.long && sent[0].line === HIT_LINE, JSON.stringify(sent));

    // 工具卡片那颗「跳转」在这边（插件里的对话面板）还是交给编辑器打开：那边没有左边那一列
    await page.eval(`for (const m of ${JSON.stringify([
        { type: "editCardStart", toolCallId: JUMP_CARD_ID + "-view", toolName: "write", path: JUMP_FILE, label: JUMP_FILE, args: JUMP_ARGS, sessionId: sessionInfo.sessionId },
        { type: "editCardResult", toolCallId: JUMP_CARD_ID + "-view", canRevert: false, diff: "", sessionId: sessionInfo.sessionId },
    ])}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(300);
    console.log("点 write 卡片那颗标签：" + await showJumpTip());
    const viewJump = await waitJumpBtn();
    check("插件里的对话面板里那颗「跳转」说的是开在编辑器里",
        viewJump.found && viewJump.title.indexOf("编辑器") >= 0 && viewJump.title.indexOf(JUMP_FILE) >= 0, viewJump.title);
    console.log("点「跳转」：" + await clickJumpBtn());
    await page.sleep(400);
    const jumpSent = JSON.parse(await page.eval(`return JSON.stringify((window.__sentToHost || []).filter(function (m) {
        return m && m.type === "openFile" && m.path === ${JSON.stringify(JUMP_FILE)};
    }));`));
    check("插件里的对话面板里点那颗「跳转」照旧交给编辑器打开", jumpSent.length === 1 && jumpSent[0].line === 1, JSON.stringify(jumpSent));
    await page.shot("file-7-webview.png");

    const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
    console.log("\n=== 判断 ===");
    console.log("通过 " + (checks.length - failed.length) + " / " + checks.length);
    if (failed.length) { throw new Error("有 " + failed.length + " 项没通过：\n  - " + failed.join("\n  - ")); }
};
