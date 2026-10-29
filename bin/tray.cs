/*
 * tray —— 通知区域里那颗图标（Windows）和右下角那块提醒面板。
 *
 * 干什么：后端有事（某个会话跑完一轮、模型在等你答一道选择题）时，在屏幕右下角弹一张小卡片，
 * 写着哪个会话、说了什么；点那张卡片，界面就切到那个会话。
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
 * 协议：一行一条，字段之间用制表符分开，两边都是 UTF-8。
 *   后端 → 这里：
 *     pop  \t 标识 \t 名字 \t 摘要 \t 类型 \t 页面   右下角弹一条
 *                                               （类型：done 跑完一轮 / ask 等你答；
 *                                                页面：别的机器推来的那一条才有）
 *     stdin 关了就是收摊（后端退出时不一定来得及说一声）
 *   这里 → 后端：
 *     pick \t 标识 \t 页面   面板上点了那一条
 */
using System;
using System.Collections.Concurrent;
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
    /** 别的机器推来的那一条才有：点了要打开它那边的页面。 */
    public string Page = "";
    public bool Ask;
    public DateTime ShownAt = DateTime.UtcNow;
    /** 卡片右下角写的时间：这条事发生的时刻（本地时间）。 */
    public DateTime At = DateTime.Now;
}

/**
 * 屏幕右下角那块提醒面板：有事就弹一条，最多同时三条，再来就挤掉最老的那条。
 *
 * 停几秒自己淡出；鼠标移上去就停住；点一条就切到那个会话并收起。
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

    private static readonly Color Accent = Color.FromArgb(0xE5, 0x39, 0x35);
    private static readonly Color AskColor = Color.FromArgb(0xF2, 0xA0, 0x3D);

    private readonly List<NoteItem> notes = new List<NoteItem>();
    private readonly Action<string, string> onPick;
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
    private int hoverIndex = -1;
    private bool fading;
    private bool placed;
    /** 整块的透明度（0~1）：滑入淡入、到点淡出都改它。 */
    private float alpha = 1f;
    /** 画好之后再贴上屏幕的那张位图（尺寸不变就复用）。 */
    private Bitmap canvas;

    public NoteWindow(Action<string, string> onPick)
    {
        this.onPick = onPick;
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
    public void Add(string id, string name, string text, bool ask, string page)
    {
        for (int i = notes.Count - 1; i >= 0; i--)
        {
            if (notes[i].Id == id) { notes.RemoveAt(i); }
        }
        NoteItem item = new NoteItem();
        item.Id = id;
        item.Name = string.IsNullOrEmpty(name) ? "会话" : name;
        item.Text = Shorten(text);
        item.Page = page ?? "";
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
        int hover = inside ? IndexAt(at.Y) : -1;
        if (hover != hoverIndex) { hoverIndex = hover; Render(); }
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

    /** 这个纵坐标落在第几条上（不在任何一条上就给 -1）。 */
    private int IndexAt(int y)
    {
        y -= shadow;
        int index = (y - pad) / (itemHeight + gap);
        if (index < 0 || index >= notes.Count) { return -1; }
        if ((y - pad) - index * (itemHeight + gap) > itemHeight) { return -1; }
        return index;
    }

    /** 点了一条：交回后端（切到那个会话 / 打开它那边的页面），这条从面板上收掉。 */
    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        if (e.Button != MouseButtons.Left || fading) { return; }
        int index = IndexAt(e.Y);
        if (index < 0) { return; }
        NoteItem picked = notes[index];
        notes.RemoveAt(index);
        if (onPick != null) { onPick(picked.Id, picked.Page); }
        if (notes.Count == 0) { fading = true; }
        else { Relayout(); }
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
        Color cardBackHover = light ? Color.FromArgb(0xF1, 0xF1, 0xF1) : Color.FromArgb(0x40, 0x40, 0x40);
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
                using (SolidBrush b = new SolidBrush(i == hoverIndex ? cardBackHover : cardBack)) { g.FillPath(b, path); }
                using (Pen p = new Pen(border)) { g.DrawPath(p, path); }
            }

            // 左边那道竖条：跑完了一轮是红，等你答是橙
            Color mark = item.Ask ? AskColor : Accent;

            int left = card.Left + (int)Math.Round(14 * scale);
            int right = card.Right - (int)Math.Round(12 * scale);
            string tag = item.Ask ? "等你答" : "跑完了";
            SizeF tagSize = g.MeasureString(tag, tagFont);
            RectangleF titleRect = new RectangleF(left, card.Top + (int)Math.Round(8 * scale),
                right - left - tagSize.Width - (int)Math.Round(8 * scale), (int)Math.Round(20 * scale));
            RectangleF tagRect = new RectangleF(right - tagSize.Width, card.Top + (int)Math.Round(11 * scale),
                tagSize.Width + 2, tagSize.Height);
            using (StringFormat oneLine = new StringFormat())
            {
                oneLine.Trimming = StringTrimming.EllipsisCharacter;
                oneLine.FormatFlags = StringFormatFlags.NoWrap;
                oneLine.LineAlignment = StringAlignment.Near;
                using (SolidBrush b = new SolidBrush(nameColor)) { g.DrawString(item.Name, titleFont, b, titleRect, oneLine); }
                using (SolidBrush b = new SolidBrush(mark)) { g.DrawString(tag, tagFont, b, tagRect, oneLine); }
            }

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
        base.OnFormClosed(e);
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

/** 一颗托盘图标 + 右下角那块面板 + 跟后端说话的那两头。 */
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
    private readonly StreamWriter toBackend;
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

        // 后端那边是管道，用明确的 UTF-8 读写，不指望控制台的代码页
        toBackend = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        toBackend.AutoFlush = true;
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
     * 面板自己管叠放（最多三条）、超时收走、点了切到那个会话。
     */
    private void PopNote(string[] parts)
    {
        string id = parts.Length > 1 ? parts[1] : "";
        if (id.Length == 0) { return; }
        string name = parts.Length > 2 ? parts[2] : "";
        string text = parts.Length > 3 ? parts[3] : "";
        bool ask = parts.Length > 4 && parts[4] == "ask";
        string page = parts.Length > 5 ? parts[5] : "";
        if (noteWindow == null)
        {
            noteWindow = new NoteWindow(delegate (string picked, string pickedPage)
            {
                Emit("pick\t" + picked + "\t" + pickedPage);
            });
            noteWindow.FormClosed += delegate { noteWindow = null; };
        }
        noteWindow.Add(id, name, text, ask, page);
    }

    /** 往后端写一行。后端没了也不当回事：下一拍读 stdin 会读到结尾，跟着退出。 */
    private void Emit(string line)
    {
        try { toBackend.WriteLine(line); }
        catch { }
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
