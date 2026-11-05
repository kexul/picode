// tray.exe 点卡片那条路的验证，配 npm run web:shot -- --script dev/trayClickTest.js 用：
//   1. 单独起一个 tray.exe（不走后端），喂一条 pop：右下角弹出一张卡片
//   2. 按卡片在代码里的摆法算出它落在屏幕哪儿，用脚本挪鼠标、真点一下
//   3. tray.exe 该往 stdout 写 `open \t 标识 \t 1`：按标题开头认到那个窗口、拉到前台了
//   4. 顺手验「点在卡片外面不写 open」（点在卡片缝上）
// 只在 Windows 上有得验（tray.exe 是 Windows 的）。
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const repoRoot = path.join(__dirname, "..");

module.exports = async (page, extras) => {
  if (process.platform !== "win32") { console.log("不是 Windows，没有托盘可验。"); return; }

  // 卡片在代码里的摆法（bin/tray.cs 的 NoteWindow.Add）：全按 96 分之 DPI 缩放
  const geo = await clickCardGeometry();
  const item = {
    id: "tray-click-test:" + Date.now(),
    name: "点击测试会话",
    summary: "这是一张验点击的卡片，点一下就该没了",
    kind: "done",
    host: (os.hostname() || "") + "-pi",
  };

  const child = spawn(path.join(repoRoot, "bin", "tray.exe"), [], { stdio: ["pipe", "pipe", "ignore"] });
  let win = null;   // 验「认到窗口」时开的那个浏览器窗口（finally 里要关掉，得挂在 try 外面）
  child.stdout.setEncoding("utf8");
  const lines = [];
  let waiter = null;
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text) { continue; }
      lines.push(text);
      if (waiter) { const w = waiter; waiter = null; w(); }
    }
  });
  const write = (line) => new Promise((resolve) => { child.stdin.write(line + "\n", resolve); });
  const waitLine = (ms) => new Promise((resolve) => {
    if (lines.length > 0) { resolve(); return; }
    const timer = setTimeout(() => { waiter = null; resolve(); }, ms);
    waiter = () => { clearTimeout(timer); resolve(); };
  });

  try {
    await write(["pop", item.id, item.name, item.summary, item.kind, item.host].join("\t"));
    await sleep(1500);   // 等它滑进来

    // 开一个显示着调试页面的真浏览器窗口（标题开头正是机器名-pi）：
    // 「认到窗口、拉到前台」那条路要有这么个窗口才验得着
    win = openBrowserWindow(extras.url);
    await sleep(4000);   // 等窗口出来、标题变成机器名-pi

    // 点卡片外（面板底边下面那条缝）：不该有反应
    await clickAt(geo.x, geo.below);
    await waitLine(1200);
    if (lines.length > 0) { throw new Error("点在卡片外面不该写行，实际：" + JSON.stringify(lines)); }
    console.log("✓ 点在卡片外面没反应");

    // 点卡片正中：该写 open 行
    await clickAt(geo.x, geo.y);
    await waitLine(2500);
    const openLine = lines.find((l) => l.startsWith("open\t"));
    if (!openLine) { throw new Error("点了卡片没见 open 行（收到的：" + JSON.stringify(lines) + "）"); }
    const parts = openLine.split("\t");
    if (parts[1] !== item.id) { throw new Error("open 行的标识对不上：" + openLine); }
    if (parts[2] !== "1") { throw new Error("开着一个标题对得上的浏览器窗口，该认到并拉到前台：" + openLine); }
    console.log("✓ 点卡片写了：" + openLine + "（浏览器窗口拉到前台了）");
  } finally {
    if (win) { try { win.kill(); } catch { /* 关不掉就算了 */ } }
    child.stdin.end();
    await sleep(300);
    try { child.kill(); } catch { /* 退了就算了 */ }
  }
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** 开一个显示着某个地址的真浏览器窗口（不截图，就是要一个标题对得上的窗口）。 */
function openBrowserWindow(url) {
  const { findBrowser } = require("./cdp.js");
  const exe = process.env.PICHAT_CHROME || findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-dev-traywin-"));
  return spawn(exe, ["--new-window", "--no-first-run", `--user-data-dir=${profile}`, url], { stdio: "ignore", detached: true });
}

/** 卡片该落在哪儿（屏幕物理像素）+ 拿鼠标点一下用的函数，都在 PowerShell 里算与做。 */
async function clickCardGeometry() {
  const { execFileSync } = require("child_process");
  const script = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiFix { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e); }' -Language CSharp;
[DpiFix]::SetProcessDPIAware() | Out-Null;
Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms;
$w = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;
$dpi = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero).DpiX;
$s = [Math]::Max(1.0, $dpi / 96.0);
$width = [Math]::Round(380 * $s); $item = [Math]::Round(88 * $s); $gap = [Math]::Round(8 * $s);
$pad = [Math]::Round(10 * $s); $shadow = [Math]::Round(6 * $s); $margin = [Math]::Round(12 * $s);
$left = $w.Right - $margin - $width - $shadow;
$h = $shadow * 2 + $pad * 2 + $item;
$bottom = $w.Bottom - $margin + $shadow;
$x = [int]($left + $shadow + $pad + ($width - 2 * $pad) / 2);
$y = [int]($bottom - $h + $shadow + $pad + $item / 2);
$below = [int]($bottom - 2);
Write-Output "$x $y $below"`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const [x, y, below] = out.trim().split(/\s+/).map(Number);
  return { x, y, below };
}

async function clickAt(x, y) {
  // 这里拿不到上面闭包里的 click，重开一次算不了 —— 简单起见直接再起 PowerShell 点
  const { execFileSync } = require("child_process");
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiFix3 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e); }'; [DpiFix3]::SetProcessDPIAware() | Out-Null; [DpiFix3]::SetCursorPos(${x},${y}) | Out-Null; Start-Sleep -Milliseconds 120; [DpiFix3]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60; [DpiFix3]::mouse_event(4,0,0,0,0);`],
    { encoding: "utf8" });
}
