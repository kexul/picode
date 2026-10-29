/*
 * tray —— 通知区域里那颗图标（Windows）和右下角那块提醒面板。
 *
 * 干什么：后端有事（某个会话跑完一轮、模型在等你答一道选择题）时，在屏幕右下角弹一张小卡片，
 * 写着哪个会话、说了什么。它只是给人看一眼，鼠标点它什么也不发生。
 * 通知区域里那颗图标只是“它在跑”的招牌：标记右下角那根竖线一直是红的，不闪、也不表示有没有事
 * （消息看没看过，后端判断不了）；点它什么也不弹。
 *
 * 为什么单独一个常驻小程序：托盘图标得住在一个有窗口消息循环的进程里（.NET 的 NotifyIcon），
 * 后端（Node）那边没有这个东西，只能起这么一个把图标端着。后端退出 → 这个进程的 stdin
 * 关闭 → 自己退出，不留孤儿。
 *
 * 跟浏览器通知那条路没有关系，也不用问谁要权限：图标是我们自己进程里的。
 *
 * 编法见 scripts/compile.mjs（跟 bin/shot.cs 一样用系统自带的 csc.exe，
 * 只是这里用 -target:winexe，免得弹一个黑框）。
 *
 * 协议：一行一条，字段之间用制表符分开，UTF-8。
 *   后端 → 这里：
 *     pop \t 标识 \t 名字 \t 摘要 \t 类型   右下角弹一条（类型：done 跑完一轮 / ask 等你答）
 *     stdin 关了就是收摊（后端退出时不一定来得及说一声）
 *   这里什么都不往回写：面板只是给人看的，点了也没反应。
 */
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [STAThread]
    private static void Main()
    {
        // 按屏幕的缩放画：不声明的话，高 DPI 屏上这块面板会被系统拉伸成模糊的小图
        try { SetProcessDPIAware(); }
        catch { /* 老系统没这个函数，就当没有 */ }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayContext());
    }
}

/** 任务栏是浅色的吗（浅色面板上用深色字）。读不到就当深色。 */
static class Theme
{
    public static bool IsLight()
    {
        try
        {
            using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                object value = key == null ? null : key.GetValue("SystemUsesLightTheme");
                return value is int && (int)value == 1;
            }
        }
        catch
        {
            return false;
        }
    }
}

/**
 * 分层窗口（UpdateLayeredWindow）：一张带透明度的位图直接贴到屏幕上，
 * 圆角、淡入淡出都是画出来的 —— 用 Region 裁剪只能切成硬边，弧线上会有一格格台阶。
 */
static class Layered
{
    public const int WS_EX_LAYERED = 0x00080000;
    private const int ULW_ALPHA = 0x00000002;
    private const byte AC_SRC_OVER = 0x00;
    private const byte AC_SRC_ALPHA = 0x01;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int Width; public int Height; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
        IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    /** 把一张画好的位图贴到屏幕上的 (x, y)，opacity 是整块的透明度（0~255）。 */
    public static void Present(IntPtr hwnd, Bitmap bitmap, int x, int y, byte opacity)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        IntPtr hbmp = bitmap.GetHbitmap(Color.FromArgb(0));
        IntPtr old = SelectObject(mem, hbmp);
        try
        {
            POINT dst = new POINT();
            dst.X = x;
            dst.Y = y;
            SIZE size = new SIZE();
            size.Width = bitmap.Width;
            size.Height = bitmap.Height;
            POINT src = new POINT();
            BLENDFUNCTION blend = new BLENDFUNCTION();
            blend.BlendOp = AC_SRC_OVER;
            blend.AlphaFormat = AC_SRC_ALPHA;
            blend.SourceConstantAlpha = opacity;
            UpdateLayeredWindow(hwnd, screen, ref dst, ref size, mem, ref src, 0, ref blend, ULW_ALPHA);
        }
        finally
        {
            SelectObject(mem, old);
            DeleteObject(hbmp);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

/** 右下角面板里的一条：哪个会话有事、它说了什么、什么时候的事。 */
class NoteItem
{
    public string Id = "";
    public string Name = "会话";
    public string Text = "";
    public bool Ask;
    public DateTime ShownAt = DateTime.UtcNow;
    /** 卡片右下角写的时间：这条事发生的时刻（本地时间）。 */
    public DateTime At = DateTime.Now;
}

/**
 * 屏幕右下角那块提醒面板：有事就弹一条，最多同时三条，再来就挤掉最老的那条。
 *
 * 停几秒自己淡出；鼠标移上去就停住（好看完）；点它没任何反应。
 * 不抢焦点、不占任务栏：人正在别处打字时，它只该被看见，不该打断。
 */
class NoteWindow : Form
{
    /** 一条停多久：到点自己收走。 */
    private const int SHOW_MS = 6000;
    /** 动画与倒计时都靠这一拍。 */
    private const int TICK_MS = 30;
    /** 最多同时摆几条。 */
    private const int MAX_ITEMS = 3;
    /** 面板外面留多宽一圈给阴影（逻辑像素）。 */
    private const int SHADOW_PX = 6;

    private static readonly Color AskColor = Color.FromArgb(0xF2, 0xA0, 0x3D);
    /** 「等你答」那颗圈和问号：浅色面板上用深一点的黄，深色的面板上用亮一点的黄。 */
    private static readonly Color AskLight = Color.FromArgb(0xD1, 0x86, 0x16);
    /** 行尾那颗「跑完了」的圈和勾：浅色面板上用深一点的绿，深色面板上用亮一点的绿。 */
    private static readonly Color DoneLight = Color.FromArgb(0x1A, 0x7F, 0x37);
    private static readonly Color DoneDark = Color.FromArgb(0x3F, 0xB9, 0x50);

    /**
     * 「跑完了」和「等你答」的图形：VSCode 那套图标（@vscode/codicons，MIT）里现成的
     * pass 与 question，原样搬过来（16x16 的 viewBox，填充靠 evenodd 挖出内圈和笔画）。
     * 颜色不跟它们走：两个图形填的是这里定的绿和黄。
     */
    private const string DonePathData =
        "M6.27 10.87h.71l4.56-4.56-.71-.71-4.2 4.21-1.92-1.92L4 8.6l2.27 2.27z" +
        "M8.6 1c1.6.1 3.1.9 4.2 2 1.3 1.4 2 3.1 2 5.1 0 1.6-.6 3.1-1.6 4.4-1 1.2-2.4 2.1-4 2.4" +
        "-1.6.3-3.2.1-4.6-.7-1.4-.8-2.5-2-3.1-3.5C.9 9.2.8 7.5 1.3 6c.5-1.6 1.4-2.9 2.8-3.8C5.4 1.3 7 .9 8.6 1z" +
        "m.5 12.9c1.3-.3 2.5-1 3.4-2.1.8-1.1 1.3-2.4 1.2-3.8 0-1.6-.6-3.2-1.7-4.3-1-1-2.2-1.6-3.6-1.7" +
        "-1.3-.1-2.7.2-3.8 1-1.1.8-1.9 1.9-2.3 3.3-.4 1.3-.4 2.7.2 4 .6 1.3 1.5 2.3 2.7 3 1.2.7 2.6.9 3.9.6z";
    private const string AskPathData =
        "M7.5 1a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 12a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" +
        "m1.55-8.42a1.84 1.84 0 0 0-.61-.42A2.25 2.25 0 0 0 7.53 4a2.16 2.16 0 0 0-.88.17c-.239.1-.45.254-.62.45" +
        "a1.89 1.89 0 0 0-.38.62 3 3 0 0 0-.15.72h1.23a.84.84 0 0 1 .506-.741.72.72 0 0 1 .304-.049.86.86 0 0 1 .27 0" +
        " .64.64 0 0 1 .22.14.6.6 0 0 1 .16.22.73.73 0 0 1 .06.3c0 .173-.037.343-.11.5a2.4 2.4 0 0 1-.27.46l-.35.42" +
        "c-.12.13-.24.27-.35.41a2.33 2.33 0 0 0-.27.45 1.18 1.18 0 0 0-.1.5v.66H8v-.49a.94.94 0 0 1 .11-.42 " +
        "3.09 3.09 0 0 1 .28-.41l.36-.44a4.29 4.29 0 0 0 .36-.48 2.59 2.59 0 0 0 .28-.55 1.91 1.91 0 0 0 .11-.64 " +
        "2.18 2.18 0 0 0-.1-.67 1.52 1.52 0 0 0-.35-.55zM6.8 9.83h1.17V11H6.8V9.83z";

    private readonly List<NoteItem> notes = new List<NoteItem>();
    /** 行尾那两颗标记的图形（按当前尺寸摊好的一份，尺寸变了重建）。 */
    private GraphicsPath donePath;
    private GraphicsPath askPath;
    private RectangleF markBox = RectangleF.Empty;
    private readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
    private readonly Font titleFont;
    private readonly Font bodyFont;
    private readonly Font tagFont;
    private readonly bool light;
    private readonly float scale;
    private readonly int width;
    private readonly int itemHeight;
    private readonly int gap;
    private readonly int pad;
    /** 窗口比面板本身往外多出来的一圈（给阴影）。 */
    private readonly int shadow;
    /** 面板底边的位置（工作区底边往上留一点）：条数变了只往上长，底边不动。 */
    private int bottom;
    /** 完全滑进来之后该在的左边缘。 */
    private int targetLeft;
    /** 还要往左滑多少像素（滑入动画）。 */
    private int slide;
    private bool fading;
    private bool placed;
    /** 整块的透明度（0~1）：滑入淡入、到点淡出都改它。 */
    private float alpha = 1f;
    /** 画好之后再贴上屏幕的那张位图（尺寸不变就复用）。 */
    private Bitmap canvas;

    public NoteWindow()
    {
        light = Theme.IsLight();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        DoubleBuffered = true;
        BackColor = light ? Color.FromArgb(0xF7, 0xF7, 0xF7) : Color.FromArgb(0x2A, 0x2A, 0x2A);

        // 像素尺寸按屏幕的实际缩放算；字体的点数由系统自己按 DPI 换算，别重复放大
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) { scale = Math.Max(1f, g.DpiX / 96f); }
        width = (int)Math.Round(380 * scale);
        itemHeight = (int)Math.Round(88 * scale);
        gap = (int)Math.Round(8 * scale);
        pad = (int)Math.Round(10 * scale);
        shadow = (int)Math.Round(SHADOW_PX * scale);
        titleFont = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point);
        bodyFont = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
        tagFont = new Font("Microsoft YaHei UI", 7.5f, FontStyle.Regular, GraphicsUnit.Point);

        tick.Interval = TICK_MS;
        tick.Tick += (s, e) => Step();
    }

    /** 弹出来那一下不抢焦点：人在别的窗口里打字，别被这块面板打断。 */
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    /** 分层窗口：内容是带透明度的位图，圆角、淡入淡出都是画出来的，边缘才平滑。 */
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= Layered.WS_EX_LAYERED;
            return cp;
        }
    }

    /** 后端叫弹一条：同一个会话只留最新那条（反复跑完不叠成一摞）。 */
    public void Add(string id, string name, string text, bool ask)
    {
        for (int i = notes.Count - 1; i >= 0; i--)
        {
            if (notes[i].Id == id) { notes.RemoveAt(i); }
        }
        NoteItem item = new NoteItem();
        item.Id = id;
        item.Name = string.IsNullOrEmpty(name) ? "会话" : name;
        item.Text = Shorten(text);
        item.Ask = ask;
        notes.Add(item);
        while (notes.Count > MAX_ITEMS) { notes.RemoveAt(0); }

        if (fading)
        {
            // 上一波正在播淡出：新的一条来了就别收了，直接接着显示
            fading = false;
            alpha = 1f;
        }
        if (!placed)
        {
            placed = true;
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            int margin = (int)Math.Round(12 * scale);
            // 窗口比面板多一圈阴影：把多出来的那圈让出去，面板本身还是离屏幕边 margin
            bottom = work.Bottom - margin + shadow;
            targetLeft = work.Right - margin - width - shadow;
            slide = (int)Math.Round(24 * scale);
            alpha = 0.05f;
            int h = HeightFor(notes.Count);
            Bounds = new Rectangle(targetLeft + slide, bottom - h, width + shadow * 2, h);
            Show();
            tick.Start();
        }
        else
        {
            Relayout();
        }
        Render();
    }

    /** 一拍：滑入 / 计时 / 淡出，三件事都在这里推进。 */
    private void Step()
    {
        if (fading)
        {
            alpha -= 0.12f;
            if (alpha <= 0.02f) { Close(); return; }
            Render();
            return;
        }
        if (slide > 0)
        {
            slide -= Math.Max(2, (int)Math.Round(6 * scale));
            if (slide <= 0)
            {
                slide = 0;
                Left = targetLeft;
                alpha = 1f;   // 滑进来就得不透了，别停在半透明上
                Render();
                return;
            }
            Left = targetLeft + slide;
            alpha = Math.Min(1f, alpha + 0.18f);
            Render();
            return;   // 滑进来这几拍先不开始计时
        }
        Point at = PointToClient(Cursor.Position);
        bool inside = ClientRectangle.Contains(at);
        if (inside)
        {
            // 鼠标在上面：把每条的开始时间往后顺延一拍，计时就停住了
            for (int i = 0; i < notes.Count; i++) { notes[i].ShownAt = notes[i].ShownAt.AddMilliseconds(TICK_MS); }
        }
        else
        {
            DateTime now = DateTime.UtcNow;
            int before = notes.Count;
            for (int i = notes.Count - 1; i >= 0; i--)
            {
                if ((now - notes[i].ShownAt).TotalMilliseconds > SHOW_MS) { notes.RemoveAt(i); }
            }
            if (notes.Count != before)
            {
                if (notes.Count == 0) { fading = true; return; }
                Relayout();
            }
        }
    }

    /** 这块面板该多高（算上外面那圈阴影）：两条之间留一道缝。 */
    private int HeightFor(int count)
    {
        return shadow * 2 + pad * 2 + count * itemHeight + Math.Max(0, count - 1) * gap;
    }

    /** 条数变了：底边不动，往上长 / 往下缩。 */
    private void Relayout()
    {
        int h = HeightFor(notes.Count);
        Bounds = new Rectangle(Left, bottom - h, width + shadow * 2, h);
        Render();
    }

    /** 窗口靠画出来的透明像素收圆角，系统不需要再给窗口套一个方框背景。 */
    protected override void OnPaintBackground(PaintEventArgs e) { /* 内容全靠 Render 贴上去 */ }

    protected override void OnPaint(PaintEventArgs e) { /* 同上：分层窗口不靠这块画 */ }

    /** 画一遍整块面板，再整张贴到屏幕上（圆角是画出来的，所以边缘是平滑的）。 */
    private void Render()
    {
        if (!IsHandleCreated || Width <= 0 || Height <= 0) { return; }
        if (canvas == null || canvas.Width != Width || canvas.Height != Height)
        {
            if (canvas != null) { canvas.Dispose(); }
            canvas = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
        }
        using (Graphics g = Graphics.FromImage(canvas))
        {
            g.Clear(Color.Transparent);
            DrawContent(g);
        }
        int level = (int)Math.Round(Math.Max(0f, Math.Min(1f, alpha)) * 255);
        Layered.Present(Handle, canvas, Left, Top, (byte)level);
    }

    /** 把面板画到一张位图上：先是整块圆角底，再一条一条卡片。 */
    private void DrawContent(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        // 位图背景是透明的：不能用 ClearType（子像素渲染要算背景色，在透明底上会出彩边、发虚），
        // 用灰度抗锯齿
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;

        Color shellBack = light ? Color.FromArgb(0xF7, 0xF7, 0xF7) : Color.FromArgb(0x2A, 0x2A, 0x2A);
        Color cardBack = light ? Color.FromArgb(0xFF, 0xFF, 0xFF) : Color.FromArgb(0x35, 0x35, 0x35);
        Color border = light ? Color.FromArgb(0xE4, 0xE4, 0xE4) : Color.FromArgb(0x3E, 0x3E, 0x3E);
        Color nameColor = light ? Color.FromArgb(0x1A, 0x1A, 0x1A) : Color.FromArgb(0xF2, 0xF2, 0xF2);
        Color bodyColor = light ? Color.FromArgb(0x60, 0x60, 0x60) : Color.FromArgb(0xAD, 0xAD, 0xAD);
        Color whenColor = light ? Color.FromArgb(0x9A, 0x9A, 0x9A) : Color.FromArgb(0x7C, 0x7C, 0x7C);

        // 外面那圈阴影：由外到内一层层叠上去，越靠外越淡
        int layers = Math.Max(3, shadow);
        for (int i = layers; i >= 1; i--)
        {
            int alpha = Math.Max(2, 10 - i);
            Rectangle ring = new Rectangle(shadow - i, shadow - i, width + i * 2, Height - shadow * 2 + i * 2);
            using (GraphicsPath path = Rounded(ring, (int)Math.Round(10 * scale) + i))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, 0, 0, 0))) { g.FillPath(b, path); }
        }

        using (GraphicsPath shell = Rounded(new Rectangle(shadow, shadow, width, Height - shadow * 2),
            (int)Math.Round(10 * scale)))
        {
            using (SolidBrush b = new SolidBrush(shellBack)) { g.FillPath(b, shell); }
        }

        for (int i = 0; i < notes.Count; i++)
        {
            NoteItem item = notes[i];
            Rectangle card = new Rectangle(shadow + pad, shadow + pad + i * (itemHeight + gap), width - pad * 2, itemHeight);
            using (GraphicsPath path = Rounded(card, (int)Math.Round(6 * scale)))
            {
                using (SolidBrush b = new SolidBrush(cardBack)) { g.FillPath(b, path); }
                using (Pen p = new Pen(border)) { g.DrawPath(p, path); }
            }

            int left = card.Left + (int)Math.Round(14 * scale);
            int right = card.Right - (int)Math.Round(12 * scale);
            // 行尾那颗标记：跑完了一轮是绿圈里的勾，等你答是黄圈里的问号
            // （图形是 16x16 的，按 19 摆：圈才跟旁边那行字一般大）
            int tagSide = (int)Math.Round(19 * scale);
            RectangleF titleRect = new RectangleF(left, card.Top + (int)Math.Round(8 * scale),
                right - left - tagSide - (int)Math.Round(8 * scale), (int)Math.Round(20 * scale));
            RectangleF tagRect = new RectangleF(right - tagSide, card.Top + (int)Math.Round(10 * scale),
                tagSide, tagSide);
            using (StringFormat oneLine = new StringFormat())
            {
                oneLine.Trimming = StringTrimming.EllipsisCharacter;
                oneLine.FormatFlags = StringFormatFlags.NoWrap;
                oneLine.LineAlignment = StringAlignment.Near;
                using (SolidBrush b = new SolidBrush(nameColor)) { g.DrawString(item.Name, titleFont, b, titleRect, oneLine); }
            }
            if (item.Ask) { DrawMark(g, tagRect, light ? AskLight : AskColor, true); }
            else { DrawMark(g, tagRect, light ? DoneLight : DoneDark, false); }

            if (item.Text.Length > 0)
            {
                RectangleF bodyRect = new RectangleF(left, card.Top + (int)Math.Round(30 * scale),
                    right - left, (int)Math.Round(32 * scale));
                using (StringFormat bodyFmt = new StringFormat())
                {
                    // 高度用满就停，最后一行超出的加省略号
                    bodyFmt.Trimming = StringTrimming.EllipsisWord;
                    bodyFmt.FormatFlags = StringFormatFlags.LineLimit;
                    using (SolidBrush b = new SolidBrush(bodyColor)) { g.DrawString(item.Text, bodyFont, b, bodyRect, bodyFmt); }
                }
            }

            // 卡片右下角：这条事是什么时候的
            using (StringFormat whenFmt = new StringFormat())
            {
                whenFmt.Alignment = StringAlignment.Far;
                whenFmt.FormatFlags = StringFormatFlags.NoWrap;
                RectangleF whenRect = new RectangleF(left, card.Bottom - (int)Math.Round(19 * scale),
                    right - left, (int)Math.Round(14 * scale));
                using (SolidBrush b = new SolidBrush(whenColor))
                {
                    g.DrawString(item.At.ToString("HH:mm"), tagFont, b, whenRect, whenFmt);
                }
            }
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        tick.Stop();
        tick.Dispose();
        if (canvas != null) { canvas.Dispose(); canvas = null; }
        titleFont.Dispose();
        bodyFont.Dispose();
        tagFont.Dispose();
        DisposeMarks();
        base.OnFormClosed(e);
    }

    /** 行尾那颗标记：一个圈，里头是勾（跑完了一轮）或问号（等你答）。 */
    private void DrawMark(Graphics g, RectangleF box, Color color, bool ask)
    {
        if (markBox != box)
        {
            DisposeMarks();
            donePath = SvgPath.Parse(DonePathData, box);
            askPath = SvgPath.Parse(AskPathData, box);
            markBox = box;
        }
        using (SolidBrush b = new SolidBrush(color)) { g.FillPath(b, ask ? askPath : donePath); }
    }

    private void DisposeMarks()
    {
        if (donePath != null) { donePath.Dispose(); donePath = null; }
        if (askPath != null) { askPath.Dispose(); askPath = null; }
    }

    /** 一个圆角矩形的路径（面板本身和每条卡片都用它）。 */
    private static GraphicsPath Rounded(Rectangle rect, int radius)
    {
        GraphicsPath path = new GraphicsPath();
        if (radius <= 1) { path.AddRectangle(rect); return path; }
        int d = radius * 2;
        path.AddArc(rect.Left, rect.Top, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Top, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /** 摘要最多留这么多字：面板上就那么两行，再长也看不见。 */
    private static string Shorten(string text)
    {
        if (string.IsNullOrEmpty(text)) { return ""; }
        text = text.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Trim();
        while (text.IndexOf("  ") >= 0) { text = text.Replace("  ", " "); }
        return text.Length <= 160 ? text : text.Substring(0, 159) + "…";
    }
}

/**
 * 一小段 SVG 路径解析：把 codicon 那两段图形（16x16 的 viewBox）摊成折线装进 GraphicsPath。
 *
 * 为什么要它：那两个图形是 SVG 路径，GDI+ 只认 GraphicsPath，没有现成的解析。
 * 只认这两段里出现过的命令：M/m 起笔、L/l 直线、H/h 横线、V/v 竖线、C/c 三次曲线、
 * A/a 椭圆弧、Z/z 闭合；曲线和弧线都按小段直线摊开（这么小的图上分不出来）。
 * 填充按 evenodd：图形的内圈和笔画就是靠这个挖出来的。
 */
static class SvgPath
{
    /** 把一段路径画到 box 里（路径坐标按 16x16 换算）。 */
    public static GraphicsPath Parse(string d, RectangleF box)
    {
        GraphicsPath path = new GraphicsPath(FillMode.Alternate);
        List<PointF> sub = new List<PointF>();
        PointF cur = new PointF();
        PointF from = new PointF();
        int i = 0;
        char cmd = '\0';
        while (true)
        {
            while (i < d.Length && (char.IsWhiteSpace(d[i]) || d[i] == ',')) { i++; }
            if (i >= d.Length) { break; }
            if (char.IsLetter(d[i])) { cmd = d[i]; i++; }
            else if (cmd == 'M') { cmd = 'L'; }      // M 后面再跟数字：隐式直线
            else if (cmd == 'm') { cmd = 'l'; }
            else if (cmd == '\0') { break; }

            char kind = char.ToUpperInvariant(cmd);
            bool rel = cmd != kind;                   // 小写：坐标相对上一点
            switch (kind)
            {
                case 'M':
                    {
                        float x = Num(d, ref i), y = Num(d, ref i);
                        if (rel) { x += cur.X; y += cur.Y; }
                        Flush(path, sub);
                        cur = from = new PointF(x, y);
                        sub.Add(Map(box, x, y));
                        break;
                    }
                case 'L':
                    {
                        float x = Num(d, ref i), y = Num(d, ref i);
                        if (rel) { x += cur.X; y += cur.Y; }
                        cur = new PointF(x, y);
                        sub.Add(Map(box, x, y));
                        break;
                    }
                case 'H':
                    {
                        float x = Num(d, ref i);
                        if (rel) { x += cur.X; }
                        cur = new PointF(x, cur.Y);
                        sub.Add(Map(box, cur.X, cur.Y));
                        break;
                    }
                case 'V':
                    {
                        float y = Num(d, ref i);
                        if (rel) { y += cur.Y; }
                        cur = new PointF(cur.X, y);
                        sub.Add(Map(box, cur.X, cur.Y));
                        break;
                    }
                case 'C':
                    {
                        float x1 = Num(d, ref i), y1 = Num(d, ref i);
                        float x2 = Num(d, ref i), y2 = Num(d, ref i);
                        float x = Num(d, ref i), y = Num(d, ref i);
                        if (rel)
                        {
                            x1 += cur.X; y1 += cur.Y;
                            x2 += cur.X; y2 += cur.Y;
                            x += cur.X; y += cur.Y;
                        }
                        Cubic(sub, box, cur, new PointF(x1, y1), new PointF(x2, y2), new PointF(x, y));
                        cur = new PointF(x, y);
                        break;
                    }
                case 'A':
                    {
                        float rx = Num(d, ref i), ry = Num(d, ref i), rot = Num(d, ref i);
                        bool large = Num(d, ref i) != 0, sweep = Num(d, ref i) != 0;
                        float x = Num(d, ref i), y = Num(d, ref i);
                        if (rel) { x += cur.X; y += cur.Y; }
                        Arc(sub, box, cur, rx, ry, rot, large, sweep, new PointF(x, y));
                        cur = new PointF(x, y);
                        break;
                    }
                case 'Z':
                    Flush(path, sub);
                    cur = from;
                    break;
                default:
                    // 别的命令（这两段图形里没有）：不认得，能画的先留着
                    Flush(path, sub);
                    return path;
            }
        }
        Flush(path, sub);
        return path;
    }

    /** 一段画完了：收进路径（三 个点起步，不够的丢掉）。 */
    private static void Flush(GraphicsPath path, List<PointF> sub)
    {
        if (sub.Count >= 3) { path.AddPolygon(sub.ToArray()); }
        sub.Clear();
    }

    /** 16x16 上的一个点 → box 里的位置。 */
    private static PointF Map(RectangleF box, float x, float y)
    {
        return new PointF(box.Left + x * box.Width / 16f, box.Top + y * box.Height / 16f);
    }

    /** 三次曲线：按控制多边形的长短切几段（这么小的图上十几段就看不出来了）。 */
    private static void Cubic(List<PointF> sub, RectangleF box, PointF p0, PointF p1, PointF p2, PointF p3)
    {
        float len = Dist(p0, p1) + Dist(p1, p2) + Dist(p2, p3);
        int steps = Math.Max(6, Math.Min(24, (int)Math.Ceiling(len)));
        for (int i = 1; i <= steps; i++)
        {
            float t = (float)i / steps, u = 1 - t;
            float x = u * u * u * p0.X + 3 * u * u * t * p1.X + 3 * u * t * t * p2.X + t * t * t * p3.X;
            float y = u * u * u * p0.Y + 3 * u * u * t * p1.Y + 3 * u * t * t * p2.Y + t * t * t * p3.Y;
            sub.Add(Map(box, x, y));
        }
    }

    private static float Dist(PointF a, PointF b)
    {
        float dx = b.X - a.X, dy = b.Y - a.Y;
        return (float)Math.Sqrt(dx * dx + dy * dy);
    }

    /**
     * 椭圆弧：SVG 写的是“从这儿到那儿、半径和转向”，先换算成圆心和起止角再切段。
     * 公式照 SVG 规范里那一段（端点参数化 → 圆心参数化）。
     */
    private static void Arc(List<PointF> sub, RectangleF box, PointF p0, float rx, float ry,
        float rotDeg, bool large, bool sweep, PointF p1)
    {
        rx = Math.Abs(rx); ry = Math.Abs(ry);
        if (rx < 1e-6f || ry < 1e-6f) { sub.Add(Map(box, p1.X, p1.Y)); return; }
        double phi = rotDeg * Math.PI / 180.0;
        double cos = Math.Cos(phi), sin = Math.Sin(phi);
        double dx = (p0.X - p1.X) / 2.0, dy = (p0.Y - p1.Y) / 2.0;
        double x1 = cos * dx + sin * dy;
        double y1 = -sin * dx + cos * dy;
        double lam = x1 * x1 / (rx * (double)rx) + y1 * y1 / (ry * (double)ry);
        if (lam > 1) { double k = Math.Sqrt(lam); rx = (float)(rx * k); ry = (float)(ry * k); }
        double num = rx * (double)rx * ry * ry - rx * (double)rx * y1 * y1 - ry * (double)ry * x1 * x1;
        double den = rx * (double)rx * y1 * y1 + ry * (double)ry * x1 * x1;
        double coef = den == 0 ? 0 : (large == sweep ? -1 : 1) * Math.Sqrt(Math.Max(0, num / den));
        double cx1 = coef * (rx * y1 / ry);
        double cy1 = coef * (-ry * x1 / rx);
        double cx = cos * cx1 - sin * cy1 + (p0.X + p1.X) / 2.0;
        double cy = sin * cx1 + cos * cy1 + (p0.Y + p1.Y) / 2.0;
        double ux = (x1 - cx1) / rx, uy = (y1 - cy1) / ry;
        double vx = (-x1 - cx1) / rx, vy = (-y1 - cy1) / ry;
        double theta = Angle(1, 0, ux, uy);
        double delta = Angle(ux, uy, vx, vy);
        if (!sweep && delta > 0) { delta -= 2 * Math.PI; }
        if (sweep && delta < 0) { delta += 2 * Math.PI; }
        int steps = Math.Max(2, (int)Math.Ceiling(Math.Abs(delta) / 0.12));
        for (int i = 1; i <= steps; i++)
        {
            double t = theta + delta * i / steps;
            double px = cx + rx * Math.Cos(t) * cos - ry * Math.Sin(t) * sin;
            double py = cy + rx * Math.Cos(t) * sin + ry * Math.Sin(t) * cos;
            sub.Add(Map(box, (float)px, (float)py));
        }
    }

    /** 两个方向之间的夹角（带正负：顺时针为正）。 */
    private static double Angle(double ux, double uy, double vx, double vy)
    {
        double dot = ux * vx + uy * vy;
        double len = Math.Sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
        double a = Math.Acos(len == 0 ? 1 : Math.Max(-1, Math.Min(1, dot / len)));
        return ux * vy - uy * vx < 0 ? -a : a;
    }

    /** 读一个数：认得正负号、小数点和指数（SVG 里 1.6.1 是两个数：1.6 和 .1）。 */
    private static float Num(string d, ref int i)
    {
        while (i < d.Length && (char.IsWhiteSpace(d[i]) || d[i] == ',')) { i++; }
        int start = i;
        bool dot = false;
        if (i < d.Length && (d[i] == '+' || d[i] == '-')) { i++; }
        while (i < d.Length)
        {
            char c = d[i];
            if (char.IsDigit(c)) { i++; continue; }
            if (c == '.' && !dot) { dot = true; i++; continue; }
            break;
        }
        if (i < d.Length && (d[i] == 'e' || d[i] == 'E'))
        {
            i++;
            if (i < d.Length && (d[i] == '+' || d[i] == '-')) { i++; }
            while (i < d.Length && char.IsDigit(d[i])) { i++; }
        }
        string text = d.Substring(start, i - start);
        float value;
        if (!float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
        {
            throw new FormatException("SVG 路径里有个数没看懂：\"" + text + "\"");
        }
        return value;
    }
}

/** 一颗托盘图标 + 右下角那块面板 + 从后端收命令的那一头。 */
class TrayContext : ApplicationContext
{
    /** 从 stdin 收命令的节奏：这么多个毫秒看一次有没有新的一行。 */
    private const int PUMP_MS = 80;

    private readonly NotifyIcon icon = new NotifyIcon();
    /** 那枚图标：标记照原色，右下角那根竖线一直是红的。 */
    private readonly Icon mark;
    private readonly System.Windows.Forms.Timer pump = new System.Windows.Forms.Timer();
    /** 右下角那块提醒面板：第一次有事才建，关掉后置空。 */
    private NoteWindow noteWindow;
    private readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
    private bool closing;

    public TrayContext()
    {
        // 任务栏是浅色的就用深一点的标记，深色的就用浅一点的（跟那个 SVG 里 prefers-color-scheme 一个意思）
        Color ink = Theme.IsLight() ? Color.FromArgb(0x11, 0x11, 0x11) : Color.FromArgb(0xF6, 0xF6, 0xF6);
        Color red = Color.FromArgb(0xE5, 0x39, 0x35);
        int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
        mark = MakeMark(size, ink, red);

        icon.Icon = mark;
        icon.Text = "Pi Chat";
        icon.Visible = true;

        pump.Interval = PUMP_MS;
        pump.Tick += (s, e) => Drain();
        pump.Start();

        // 后端那边是管道（这里只读不听写），用明确的 UTF-8，不指望控制台的代码页
        Thread reader = new Thread(ReadStdin) { IsBackground = true };
        reader.Start();
    }

    /**
     * 画一枚图标：那个标记（三块拼起来的方框），右下角那根竖线是红的。
     * 直接用多边形画，不去解 SVG 路径：就这三个形状，写下来比带一个 SVG 引擎省事。
     */
    private static Icon MakeMark(int size, Color markColor, Color barColor)
    {
        using (Bitmap bmp = new Bitmap(size, size))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush brush = new SolidBrush(markColor))
                using (SolidBrush bar = new SolidBrush(barColor))
                {
                    // 左上那一块（上面一条横条 + 右边一截）
                    g.FillPolygon(brush, Poly(size, 420, 280, 280, 280, 280, 140, 0, 140, 0, 0, 420, 0));
                    // 右下角那根竖线：一直是红的
                    g.FillPolygon(bar, Poly(size, 560, 560, 420, 560, 420, 280, 560, 280));
                    // 左下那一块（阶梯状）
                    g.FillPolygon(brush, Poly(size,
                        140, 560, 0, 560, 0, 140, 140, 140, 140, 280, 280, 280, 280, 420, 140, 420));
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }

    /** 把 560×560 那个方框里的坐标按比例缩到图标的边长上。 */
    private static Point[] Poly(int size, params int[] pairs)
    {
        Point[] points = new Point[pairs.Length / 2];
        for (int i = 0; i < points.Length; i++)
        {
            points[i] = new Point(
                (int)Math.Round(pairs[i * 2] * size / 560.0),
                (int)Math.Round(pairs[i * 2 + 1] * size / 560.0));
        }
        return points;
    }

    /** 一直读后端写来的行，攒着等 pump 去取（改界面只能在有消息循环的那个线程上做）。 */
    private void ReadStdin()
    {
        try
        {
            StreamReader fromBackend = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = fromBackend.ReadLine()) != null) { inbox.Enqueue(line); }
        }
        catch
        {
            // 管道断了：跟读到头一样，当作后端没了
        }
        inbox.Enqueue("quit");
    }

    private void Drain()
    {
        string line;
        while (inbox.TryDequeue(out line)) { Handle(line); }
    }

    private void Handle(string line)
    {
        if (string.IsNullOrEmpty(line)) { return; }
        string[] parts = line.Split('\t');
        switch (parts[0])
        {
            case "pop":
                PopNote(parts);
                return;
            case "quit":
                Quit();
                return;
        }
    }

    /**
     * 后端叫弹一条：右下角那块面板里加一条。
     * 面板自己管叠放（最多三条）、超时收走（鼠标在上面时暂停）。
     */
    private void PopNote(string[] parts)
    {
        string id = parts.Length > 1 ? parts[1] : "";
        if (id.Length == 0) { return; }
        string name = parts.Length > 2 ? parts[2] : "";
        string text = parts.Length > 3 ? parts[3] : "";
        bool ask = parts.Length > 4 && parts[4] == "ask";
        if (noteWindow == null)
        {
            noteWindow = new NoteWindow();
            noteWindow.FormClosed += delegate { noteWindow = null; };
        }
        noteWindow.Add(id, name, text, ask);
    }

    private void Quit()
    {
        if (closing) { return; }
        closing = true;
        try
        {
            pump.Stop();
            icon.Visible = false;
            icon.Dispose();
            if (noteWindow != null) { noteWindow.Close(); }
        }
        catch { }
        ExitThread();
    }
}
