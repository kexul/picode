// @ts-nocheck
/**
 * makePng —— 生成一张不依赖任何第三方库的示例 PNG（只在开发调试里用）。
 *
 * 为什么需要它：调试"读图片"这类功能时，会话的工作目录里得有张真图。
 * 这台机器上不一定装了画图工具，所以自己写一个最小的 PNG 编码：
 * 图像数据（每行前面一个 0 = 不过滤）→ zlib 压缩 → IHDR/IDAT/IEND 三个块。
 */
const fs = require("fs");
const zlib = require("zlib");

/** CRC32 表（PNG 每个块末尾要带）。 */
const CRC_TABLE = (() => {
    const table = new Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/**
 * 写一张竖条渐变图（颜色分明，缩放到窗口宽度后一眼能看出比例对不对）。
 * @param {string} file 写到哪儿
 * @param {number} [width] 宽，默认 1600（比对话区宽，用来看"拉到页面宽度"）
 * @param {number} [height] 高，默认 400
 */
function writeSamplePng(file, width = 1600, height = 400) {
    const stride = width * 3 + 1;          // 每行：1 字节过滤标记 + RGB
    const raw = Buffer.alloc(stride * height);
    let at = 0;
    for (let y = 0; y < height; y++) {
        raw[at++] = 0;
        for (let x = 0; x < width; x++) {
            const band = Math.floor((x / width) * 8);
            const down = y / height;
            raw[at++] = Math.round(40 + band * 25);
            raw[at++] = Math.round(200 * (1 - down) + 40 * down);
            raw[at++] = Math.round(120 + 100 * down);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // 每个通道 8 位
    ihdr[9] = 2;    // 真彩色 RGB
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]));
}

module.exports = { writeSamplePng };
