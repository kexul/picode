/*
 * notice —— 右下角那张「有事」的提醒卡片（Windows）。
 *
 * 干什么：哪个会话跑完了一轮、或者模型在那儿等你答一句，后端就把一条 show 写进它的标准输入，
 * 它在这台机器右下角画一张小卡片（最多三张叠着）。卡片可以点（这里把这一下告诉后端，
 * 后端叫开着的网页切到那个会话，再回一条 raise 过来说“把开着那个页面的窗口提到前面”）、
 * 可以点右上角那颗 × 顺手关掉，后端也能说「这个会话已经说上话了 / 关掉了」把某一张收走。
 *
 * 为什么单独编一支小程序：安卓 app 与桌面小窗口都退休了，提醒不能跟着一起没。这支没有通知区域
 * 图标、没有主界面，只在有事的时候画卡片。后端一起来就把它拉起来（标准输入一直开着），
 * 它自己不会退；后端一退（标准输入关掉）它跟着收摊。没在 Windows 上、或者这支没编出来，
 * 后端就静悄悄地不弹，其余照常（浏览器页面里照样看得到）。
 *
 * 那张卡片是一扇「分层窗口」（WS_EX_LAYERED + UpdateLayeredWindow）：自己画一张 32 位带透明度的图
 * 贴到屏幕上，所以左上角那颗「标签」的小标签能一半挑到卡片外面、边缘还是干净的抗锯齿，
 * 底下透出来的是真的桌面（不是拿某个颜色冒充透明 —— 那样抗锯齿的那几个像素会跟透明色混成一圈杂边）。
 * 窗口形状又按“卡片本体 + 那颗标签”裁过（见 NoticeCard.Shape）：鼠标只在这两处归它管，
 * 标签周围那几条透明地带鼠标和点击都穿过去。
 *
 * 编法见 scripts/compile.mjs：用 Windows 自带的 csc.exe（.NET Framework）编成 bin/notice.exe，
 * 编译时带上 /codepage:65001（本文件是 UTF-8，不指明白 csc 会按系统代码页读，中文注释会乱）。
 * 这支用的是系统自带的 WinForms，一个第三方包都不引。
 *
 * 协议（一行一条，字段之间拿制表符隔开；标题、正文、标签是 UTF-8 码的 base64，省得跟制表符打架）：
 *   后端写进来：
 *     show<TAB>标识<TAB>0|1<TAB>标题<TAB>正文<TAB>标签     0 = 跑完一轮，1 = 在等你答一句
 *                                                    标签（可省，旧后端不带）= 设置里那行「标签」
 *     close<TAB>标识                              把那一张收走（那个会话已经说上话了 / 关掉了）
 *     raise<TAB>窗口标题                           把标题对得上的那个窗口提到前面（人点了卡片以后发，见 Raiser）
 *     closeall                                    全收走
 *   它写出去：
 *     click<TAB>标识                              人点了那一张（后端据此叫开着的网页切过去）
 *
 * 用法：notice.exe < 管道
 */
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class Program
{
    // 高分屏（缩放 125% / 150%）上不声明的话，整张卡片是被系统放大过的模糊图。
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [STAThread]
    private static void Main(string[] args)
    {
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // 后端起它的时候标准输入是根管道，读到的每一行就是一条命令。
        var pump = new Pump();
        var context = new ApplicationContext();
        var reader = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    var copy = line;
                    pump.Post(delegate { Hub.Command(copy); });
                }
            }
            catch { /* 管道断了：跟后端一起收摊 */ }
            pump.Post(delegate
            {
                Hub.CloseAll();
                context.ExitThread();
            });
        });
        reader.IsBackground = true;
        reader.Name = "notice-stdin";
        reader.Start();
        Application.Run(context);
    }
}

/// <summary>
/// 把后台线程读到的命令送回界面那条线程（卡片得在界面线程上建、上关）。
/// 本身是个看不见的窗口，只借它一个句柄：Application.Run 的消息环替它转这些委托。
/// </summary>
sealed class Pump : Control
{
    public Pump()
    {
        var unused = Handle;
        GC.KeepAlive(unused);
    }

    public void Post(Action action)
    {
        try { BeginInvoke(action); }
        catch { /* 还没建好 / 已经在收摊：那就算了 */ }
    }
}

/// <summary>卡片那一摞：谁进来了、谁走了、各摆在哪。</summary>
static class Hub
{
    private const int MaxCards = 3;
    private const int Gap = 8;
    private const int Edge = 12;

    private static readonly List<NoticeCard> Cards = new List<NoticeCard>();

    /// <summary>后端写来的一行。</summary>
    public static void Command(string line)
    {
        if (line == null) { return; }
        line = line.TrimEnd('\r');
        if (line.Length == 0) { return; }
        var parts = line.Split('\t');
        if (parts[0] == "show") { Show(parts); return; }
        if (parts[0] == "close")
        {
            if (parts.Length > 1) { CloseKey(parts[1]); }
            return;
        }
        if (parts[0] == "raise")
        {
            if (parts.Length > 1) { Raiser.BringToFront(Decode(parts[1])); }
            return;
        }
        if (parts[0] == "closeall") { CloseAll(); }
    }

    private static void Show(string[] parts)
    {
        if (parts.Length < 5) { return; }
        var key = parts[1];
        var ask = parts[2] == "1";
        var title = Decode(parts[3]);
        var body = Decode(parts[4]);

        var tag = parts.Length > 5 ? Decode(parts[5]) : "";

        // 同一个会话反复推过来：换掉旧的（人看的是最新的那条）
        CloseKey(key, false);
        if (Cards.Count >= MaxCards)
        {
            // 挤掉最老的那张：告诉后端一声（它那边存着一份“屏幕上现在有哪几张”的镜像）
            var oldest = Cards[0];
            Cards.RemoveAt(0);
            oldest.CloseNow();
            EmitClosed(oldest.Key);
        }

        var card = new NoticeCard(key, title, body, ask, tag);
        card.Clicked += OnClicked;
        Cards.Add(card);
        card.Show();
        Arrange();
        Chime.Play(ask);
    }

    /// <summary>人点了哪一张：告诉后端（它叫开着的网页切到那个会话），这张收走。</summary>
    private static void OnClicked(string key)
    {
        try
        {
            Console.Out.WriteLine("click\t" + key);
            Console.Out.Flush();
        }
        catch { /* 后端不在了：点了也没处说 */ }
        CloseKey(key);
    }

    /// <summary>收走某一标识的那一张（没有就什么也不做）。</summary>
    /// <param name="notify">后端要不要知道（人点叉 / 挤掉最老时要；后端自己下命令关时不要）。</param>
    private static void CloseKey(string key, bool notify = false)
    {
        for (var i = 0; i < Cards.Count; i++)
        {
            if (Cards[i].Key != key) { continue; }
            var card = Cards[i];
            Cards.RemoveAt(i);
            card.CloseNow();
            Arrange();
            if (notify) { EmitClosed(key); }
            return;
        }
    }

    /// <summary>告诉后端：这张自己没了（点了叉 / 被挤掉）。</summary>
    private static void EmitClosed(string key)
    {
        try
        {
            Console.Out.WriteLine("closed\t" + key);
            Console.Out.Flush();
        }
        catch { /* 后端不在了：也不影响什么 */ }
    }

    /// <summary>卡片自己被点掉了（那颗叉）：跟后端说一声。</summary>
    public static void CloseKeyFromCard(string key)
    {
        CloseKey(key, true);
    }

    public static void CloseAll()
    {
        foreach (var card in Cards.ToArray()) { card.CloseNow(); }
        Cards.Clear();
    }

    /// <summary>从下往上排：最先弹的那张在最下面。</summary>
    private static void Arrange()
    {
        if (Screen.PrimaryScreen == null) { return; }
        var area = Screen.PrimaryScreen.WorkingArea;
        var bottom = area.Bottom - Edge;
        for (var i = Cards.Count - 1; i >= 0; i--)
        {
            var card = Cards[i];
            card.Left = area.Right - card.Width - Edge;
            card.Top = bottom - card.Height;
            bottom = card.Top - Gap;
        }
    }

    private static string Decode(string base64)
    {
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(base64)); }
        catch { return ""; }
    }
}

/// <summary>
/// 一张卡片：白底方形（四个角都是直角），左边一条竖线（等你答是黄的，跑完是绿的），右上角一颗 ×。
/// 它不抢焦点（ShowWithoutActivation），鼠标点上去才有反应；不会自己走掉 ——
/// 要么人点了它 / 点掉那颗 ×，要么后端说那个会话已经说上话了。
/// </summary>
sealed class NoticeCard : Form
{
    private const int CardWidth = 340;
    private const int PadX = 12;
    private const int PadY = 9;
    private const int TitleGap = 4;
    private const int MaxBodyLines = 3;
    private const int AccentWidth = 3;
    private const int TagHeight = 18;
    /// <summary>标签再长也不宽过这个数（卡片只有这么宽，一颗标签不该顶掉整个标题）。</summary>
    private const int TagMaxWidth = 220;

    private static readonly Font TitleFont = new Font("Microsoft YaHei UI", 9.75f, FontStyle.Bold);
    private static readonly Font BodyFont = new Font("Microsoft YaHei UI", 9f);
    private static readonly Font CloseFont = new Font("Segoe UI", 12f);
    private static readonly Font TagFont = new Font("Microsoft YaHei UI", 8.25f);
    private static readonly Color TitleColor = Color.FromArgb(0x11, 0x18, 0x27);
    private static readonly Color BodyColor = Color.FromArgb(0x4B, 0x55, 0x63);
    private static readonly Color BorderColor = Color.FromArgb(0xD8, 0xDB, 0xE0);
    private static readonly Color CloseColor = Color.FromArgb(0x9A, 0xA3, 0xAF);
    private static readonly Color DoneColor = Color.FromArgb(0x2E, 0x7D, 0x32);
    private static readonly Color AskColor = Color.FromArgb(0xB2, 0x6A, 0x00);

    // 左上角那颗小标签（设置里那行「标签」）
    private static readonly Color TagBg = Color.FromArgb(0xEE, 0xF1, 0xF5);
    private static readonly Color TagColor = Color.FromArgb(0x4B, 0x55, 0x63);
    private static readonly Color TagBorderColor = Color.FromArgb(0xCF, 0xD5, 0xDD);

    /// <summary>量正文高度时的上限（够放下三行以外的东西，量出来再截到三行）。</summary>
    private const int MeasureHeight = 4000;

    private readonly string heading;
    private string detail;
    private readonly bool asking;
    private readonly int headingHeight;
    private readonly int detailHeight;
    private Rectangle closeRect;
    private bool hoverClose;

    /// <summary>左上角那颗小标签写的字（设置里那行「标签」）；空着就没有它。</summary>
    private readonly string tag;
    /// <summary>标签太长时切过一刀的那个写法（画的是它）。</summary>
    private readonly string tagText;
    /// <summary>卡片本体从窗口顶上让出来多少：小标签挑出去的那一截（不挑出去就是 0）。</summary>
    private readonly int cardTop;
    private readonly Rectangle tagRect;

    public string Key { get; private set; }
    public event Action<string> Clicked;

    public NoticeCard(string key, string title, string body, bool ask, string label)
    {
        Key = key;
        heading = title ?? "";
        detail = body ?? "";
        asking = ask;
        tag = label ?? "";
        // 小标签一半在卡片外面、一半压在卡片上沿——不是全装在条子里，看着才像“这颗标签挑出来了”
        cardTop = tag.Length == 0 ? 0 : TagHeight / 2;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;

        var textWidth = CardWidth - AccentWidth - PadX - PadX;
        heading = Clip(heading, TitleFont, textWidth);
        tagText = Clip(tag, TagFont, TagMaxWidth - 12);
        int tagWidth;
        using (var oneLine = OneLine())
        using (var wrapped = Wrapped())
        {
            headingHeight = Measure(heading, TitleFont, textWidth, oneLine).Height;
            var lineHeight = Measure("国A", BodyFont, textWidth, wrapped).Height;
            var wanted = Measure(detail, BodyFont, textWidth, wrapped).Height;
            detailHeight = Math.Min(wanted, lineHeight * MaxBodyLines);
            // 折行时 GDI+ 不替你补那个省略号（只把超出三行的截掉），自己截一刀补上
            if (wanted > detailHeight) { detail = Fit(detail, textWidth, detailHeight); }
            // 量的时候留出标签自己的左右内边距，不然挨到上限时字会被再切一刀、连省略号都看不见
            tagWidth = tag.Length == 0 ? 0
                : Math.Min(TagMaxWidth, Measure(tagText, TagFont, TagMaxWidth, oneLine).Width + 12);
        }

        Size = new Size(CardWidth, PadY + headingHeight + TitleGap + detailHeight + PadY + cardTop);
        closeRect = new Rectangle(Width - 26, cardTop + 6, 18, 18);
        tagRect = new Rectangle(AccentWidth + PadX, 0, tagWidth, TagHeight);
        Cursor = Cursors.Hand;
    }

    /// <summary>单行、上下居中（放不下时靠 Clip 先收成省略号，这里的 Trimming 只是兜底）。</summary>
    private static StringFormat OneLine()
    {
        var format = new StringFormat();
        format.FormatFlags |= StringFormatFlags.NoWrap;
        format.Trimming = StringTrimming.EllipsisCharacter;
        format.LineAlignment = StringAlignment.Center;
        return format;
    }

    /// <summary>照宽度折行（正文用）。</summary>
    private static StringFormat Wrapped()
    {
        var format = new StringFormat();
        format.Trimming = StringTrimming.None;
        return format;
    }

    /// <summary>一句话占多宽多高（跟 Draw 里画它用同一套排法，量出来才准）。</summary>
    private static Size Measure(string text, Font font, int maxWidth, StringFormat format)
    {
        using (var bitmap = new Bitmap(1, 1))
        using (var g = Graphics.FromImage(bitmap))
        {
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            var size = g.MeasureString(text, font, new SizeF(Math.Max(1, maxWidth), MeasureHeight), format);
            return new Size((int)Math.Ceiling(size.Width), (int)Math.Ceiling(size.Height));
        }
    }

    /// <summary>把一段话截到装得进这么多高的地方，末尾加个省略号（截到只剩一个字也不再缩）。</summary>
    /// <summary>单行放不下时收成「……」，剩下的宽度装得进多少留多少。</summary>
    private static string Clip(string text, Font font, int width)
    {
        if (width <= 0) { return ""; }
        using (var oneLine = OneLine())
        {
            if (Measure(text, font, width, oneLine).Width <= width) { return text; }
            var cut = text.Length;
            while (cut > 1)
            {
                cut = cut * 3 / 4;
                var candidate = text.Substring(0, cut).TrimEnd() + "…";
                if (Measure(candidate, font, width, oneLine).Width <= width) { return candidate; }
            }
        }
        return text.Substring(0, 1) + "…";
    }

    private static string Fit(string text, int width, int height)
    {
        using (var wrapped = Wrapped())
        {
            var cut = text.Length;
            while (cut > 1)
            {
                cut = cut * 3 / 4;
                var candidate = text.Substring(0, cut).TrimEnd() + "…";
                if (Measure(candidate, BodyFont, width, wrapped).Height <= height) { return candidate; }
            }
        }
        return text.Substring(0, 1) + "…";
    }

    /// <summary>不抢焦点：人正在别的窗口里打字，卡片不能把光标抢走。</summary>
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW（后者让它不出现在 Alt+Tab 里）
            // | WS_EX_LAYERED（下面自己按像素贴上去，小标签挑出去那半截才是真透明的）
            cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00080000;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // 形状得等窗口真有了再定一次：构造时设的那份不一定落到窗口上
        Region = Shape();
        Redraw();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        closeRect = new Rectangle(Width - 26, cardTop + 6, 18, 18);
        Redraw();
    }

    // ==================== 分层窗口：自己画一张图，按像素贴上去 ====================
    //
    // 为什么不用 TransparencyKey（“某个颜色 = 透明”）：小标签的圆角是抗锯齿画的，边缘那几个像素
    // 是灰和“透明色”的混合，混出来的东西不等于那个透明色，于是留在屏幕上成了标签外面一圈粉边。
    // 自己贴一张 32 位带透明度的图就没这回事：边缘那几个像素本来就是半透明的，跟底下正常混。

    [StructLayout(LayoutKind.Sequential)]
    private struct Point32 { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Size32 { public int Cx; public int Cy; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct BlendFunction { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref Point32 pptDst, ref Size32 psize,
        IntPtr hdcSrc, ref Point32 pptSrc, int crKey, ref BlendFunction pblend, int dwFlags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    private const int UlwAlpha = 0x02;
    private const byte AcSrcOver = 0x00;
    private const byte AcSrcAlpha = 0x01;

    /// <summary>画一遍、贴上去（位置跟着 Left/Top 走）。</summary>
    private void Redraw()
    {
        if (!IsHandleCreated) { return; }
        using (var bitmap = new Bitmap(Width, Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bitmap))
            {
                // 透明画布上不能用 ClearType（那要拿底下的像素来混），用灰度抗锯齿
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                g.Clear(Color.Transparent);
                Draw(g);
            }
            Premultiply(bitmap);

            var screen = GetDC(IntPtr.Zero);
            var memory = CreateCompatibleDC(screen);
            var handle = bitmap.GetHbitmap(Color.FromArgb(0));
            var previous = SelectObject(memory, handle);
            try
            {
                // UpdateLayeredWindow 要的是“已经乘过透明度的颜色”，GDI+ 画出来的是没乘过的，
                // 所以上面先过一遍 Premultiply。
                var target = new Point32();
                target.X = Left;
                target.Y = Top;
                var size = new Size32();
                size.Cx = Width;
                size.Cy = Height;
                var source = new Point32();
                var blend = new BlendFunction();
                blend.BlendOp = AcSrcOver;
                blend.SourceConstantAlpha = 255;
                blend.AlphaFormat = AcSrcAlpha;
                UpdateLayeredWindow(Handle, screen, ref target, ref size, memory, ref source, 0, ref blend, UlwAlpha);
            }
            finally
            {
                SelectObject(memory, previous);
                DeleteObject(handle);
                DeleteDC(memory);
                ReleaseDC(IntPtr.Zero, screen);
            }
        }
    }

    /// <summary>把颜色乘上自己的透明度（32 位图里每 4 个字节一组，最后一组那个是透明度）。</summary>
    private static void Premultiply(Bitmap bitmap)
    {
        var area = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(area, System.Drawing.Imaging.ImageLockMode.ReadWrite,
            System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        try
        {
            var bytes = new byte[data.Stride * bitmap.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            for (var i = 0; i + 3 < bytes.Length; i += 4)
            {
                var alpha = bytes[i + 3];
                if (alpha == 255 || alpha == 0) { continue; }
                bytes[i] = (byte)(bytes[i] * alpha / 255);
                bytes[i + 1] = (byte)(bytes[i + 1] * alpha / 255);
                bytes[i + 2] = (byte)(bytes[i + 2] * alpha / 255);
            }
            Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    /// <summary>一个两头圆的标签底（坐标就是外面那个矩形）。</summary>
    private static System.Drawing.Drawing2D.GraphicsPath Pill(Rectangle r)
    {
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        var d = r.Height;
        path.AddArc(r.Left, r.Top, d, d, 90, 180);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 180);
        path.CloseFigure();
        return path;
    }

    private void Draw(Graphics g)
    {
        var card = new Rectangle(0, cardTop, Width, Height - cardTop);
        var outline = new Rectangle(card.Left, card.Top, card.Width - 1, card.Height - 1);
        using (var fill = new SolidBrush(Color.White)) { g.FillRectangle(fill, outline); }
        using (var pen = new Pen(BorderColor)) { g.DrawRectangle(pen, outline); }

        // 左边那条竖线：一整条，从头到底，两头是平的（卡片没有圆角，不用担心被裁）
        using (var accent = new SolidBrush(asking ? AskColor : DoneColor))
        {
            g.FillRectangle(accent, card.Left, card.Top, AccentWidth + 1, card.Height);
        }

        var textX = AccentWidth + PadX;
        var textWidth = Width - textX - PadX;
        var titleY = cardTop + PadY;
        if (tag.Length > 0)
        {
            // 小标签压在卡片上沿上。挑出去那半截没有白底衬着，所以给一圈描边，
            // 不然浅灰的标签糊在桌面壁纸上就看不出来了。
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var path = Pill(tagRect))
            {
                using (var fill = new SolidBrush(TagBg)) { g.FillPath(fill, path); }
                using (var pen = new Pen(TagBorderColor)) { g.DrawPath(pen, path); }
            }
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.Default;
            using (var centered = OneLine())
            using (var tagBrush = new SolidBrush(TagColor))
            {
                centered.Alignment = StringAlignment.Center;
                var at = new RectangleF(tagRect.X, tagRect.Y, tagRect.Width, tagRect.Height);
                g.DrawString(tagText, TagFont, tagBrush, at, centered);
            }
        }

        using (var oneLine = OneLine())
        using (var wrapped = Wrapped())
        using (var titleBrush = new SolidBrush(TitleColor))
        using (var bodyBrush = new SolidBrush(BodyColor))
        using (var markBrush = new SolidBrush(hoverClose ? TitleColor : CloseColor))
        {
            g.DrawString(heading, TitleFont, titleBrush,
                new RectangleF(textX, titleY, textWidth, headingHeight), oneLine);
            g.DrawString(detail, BodyFont, bodyBrush,
                new RectangleF(textX, titleY + headingHeight + TitleGap, textWidth, detailHeight), wrapped);
            var centered = OneLine();
            centered.Alignment = StringAlignment.Center;
            try
            {
                g.DrawString("×", CloseFont, markBrush,
                    new RectangleF(closeRect.X, closeRect.Y, closeRect.Width, closeRect.Height), centered);
            }
            finally { centered.Dispose(); }
        }
    }

    /// <summary>
    /// 窗口的形状：卡片本体 + 那颗小标签（比标签画的边多留 2 像素，好让它的抗锯齿边不被切掉）。
    ///
    /// 为什么窗口要照形状裁：不裁的话，标签挑出去留下那条透明地带仍旧算在窗口里 ——
    /// 鼠标走到那儿光标就变成卡片的手形（底下的编辑器、浏览器那边的形状被“抢”掉了），
    /// 点一下也落在卡片上。裁掉以后那几条真的不属于这个窗口，鼠标从那穿过去。
    /// </summary>
    private Region Shape()
    {
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        // 两块是叠着的：默认的 Alternate 规则会把叠的那一小块挖成洞（标签压住卡片的那半截就没了），
        // Winding 才是“叠着就算在内”
        path.FillMode = System.Drawing.Drawing2D.FillMode.Winding;
        path.AddRectangle(new Rectangle(0, cardTop, Width, Height - cardTop));
        if (tag.Length > 0)
        {
            var grown = tagRect;
            grown.Inflate(2, 2);
            var d = grown.Height;
            path.AddArc(grown.Left, grown.Top, d, d, 90, 180);
            path.AddArc(grown.Right - d, grown.Top, d, d, 270, 180);
            path.CloseFigure();
        }
        var shape = new Region(path);
        path.Dispose();
        return shape;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var over = closeRect.Contains(e.Location);
        if (over != hoverClose)
        {
            hoverClose = over;
            Cursor = over ? Cursors.Default : Cursors.Hand;
            Redraw();
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoverClose)
        {
            hoverClose = false;
            Redraw();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left) { return; }
        if (closeRect.Contains(e.Location))
        {
            // 人点了右上角那颗叉：这张自己没了，告诉后端一声（它那份镜像跟着删）
            Hub.CloseKeyFromCard(Key);
            return;
        }
        var handler = Clicked;
        if (handler != null) { handler(Key); }
        else { Hub.Command("close\t" + Key); }
    }

    /// <summary>不带动画地消失（换卡片、清理时用）。</summary>
    public void CloseNow()
    {
        try { Close(); }
        catch { /* 已经关了 */ }
    }
}

/// <summary>
/// 把一个窗口提到前面：人点了提醒卡片以后，后端回一条 raise 过来，带的是那个页面的标题
/// （标题那份拼法只在后端一处，见 src/pageHtml.ts 的 pageTitle）。
///
/// 为什么靠标题找：后端在外面，能看见的只有窗口标题，没别的把柄。两种情况对得上：
/// 标题正好相等（`--app=` 开的、浏览器「安装成应用」装出来的那种窗口，标题就是页面标题本身）；
/// 以「标题 + " - "」开头（普通浏览器窗口，它标题是「活动那张 tab 的标题 + 浏览器名字」，
/// 所以只有那张贴在前面的时候才对得上；停在背景 tab 里就对不上——实测过的，那种窗口的标题
/// 已经换成别的 tab 了，提不起来也认不出来，那就什么也不做）。
/// 几个窗口都对得上时提 Z 序最上面那个（EnumWindows 就是从最上面往下走）：
/// 连着后端的那些页面都会切到那个会话，提哪扇看到的都是对的。
///
/// 提前面有时候会被 Windows 拦下（前台锁定）：这支刚收到那一下鼠标点击，按规矩是
/// “收到最后一次输入事件的进程”，一般拦不住；真被拦住就让任务栏上那一格闪几下，人还看得见是哪个窗口。
/// </summary>
static class Raiser
{
    /// <summary>还原（最小化过的回到它原来的样子，原来最大化的还是最大化）。</summary>
    private const int SW_RESTORE = 9;
    private const uint FLASHW_ALL = 0x3;
    private const uint FLASHW_TIMERNOFG = 0xC;

    private delegate bool EnumProc(IntPtr handle, IntPtr unused);

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public int Size;
        public IntPtr Handle;
        public uint Flags;
        public uint Count;
        public uint Timeout;
        public IntPtr UnusedHandle;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr unused);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int max);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr handle, int command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    /// <summary>把标题对得上的那个窗口还原并提到前面。找不到、或者它已经在最前面，就什么也不做。</summary>
    public static void BringToFront(string title)
    {
        if (string.IsNullOrEmpty(title)) { return; }
        try
        {
            var handle = Find(title);
            if (handle == IntPtr.Zero || handle == GetForegroundWindow()) { return; }
            // 最小化了先还原；没最小化时不碰它的大小（拿 SW_RESTORE 会把最大化的窗口缩回去），只提前面
            if (IsIconic(handle)) { ShowWindow(handle, SW_RESTORE); }
            SetForegroundWindow(handle);
            if (GetForegroundWindow() != handle) { Flash(handle); }
        }
        catch { /* 提不起来就算了：那张卡片已经收了，会话也切过去了 */ }
    }

    /// <summary>按标题找窗口：正好相等，或者以「标题 + " - "」开头（浏览器名字跟在后面那种）。拿最上面那个。</summary>
    private static IntPtr Find(string title)
    {
        var found = IntPtr.Zero;
        var prefix = title + " - ";
        EnumProc callback = delegate(IntPtr handle, IntPtr unused)
        {
            if (!IsWindowVisible(handle)) { return true; }
            var text = new StringBuilder(512);
            if (GetWindowText(handle, text, text.Capacity) == 0) { return true; }
            var name = text.ToString();
            if (name == title || name.StartsWith(prefix, StringComparison.Ordinal)) { found = handle; return false; }
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        return found;
    }

    /// <summary>提前面被拦下了：让它任务栏上那一格闪几下。</summary>
    private static void Flash(IntPtr handle)
    {
        var info = new FlashInfo();
        info.Size = Marshal.SizeOf(info);
        info.Handle = handle;
        info.Flags = FLASHW_ALL | FLASHW_TIMERNOFG;
        FlashWindowEx(ref info);
    }
}

/// <summary>
/// 响一声：跑完一轮是往上两个音，等你答一句是同一高度敲三下（跟以前一样）。
/// 自己算波形放着，不跟 Windows 的声音方案走（那里把「通知」设成无声也照样响），
/// 整机静音当然还是不响。
/// </summary>
static class Chime
{
    private const int Rate = 44100;
    private static SoundPlayer donePlayer;
    private static SoundPlayer askPlayer;

    public static void Play(bool ask)
    {
        try
        {
            if (ask)
            {
                if (askPlayer == null) { askPlayer = Build(true); }
                askPlayer.Play();
            }
            else
            {
                if (donePlayer == null) { donePlayer = Build(false); }
                donePlayer.Play();
            }
        }
        catch { /* 放不出来不影响弹卡片 */ }
    }

    private static SoundPlayer Build(bool ask)
    {
        return new SoundPlayer(new MemoryStream(Rendered(ask)));
    }

    /// <summary>两段音的波形（16 位 PCM 单声道，套上 wav 头）。</summary>
    private static byte[] Rendered(bool ask)
    {
        // 一段音 = 频率(Hz) + 多长(毫秒)；音和音之间空 40 毫秒
        int[][] steps = ask
            ? new[] { new[] { 1047, 80 }, new[] { 1047, 80 }, new[] { 1047, 80 } }
            : new[] { new[] { 880, 130 }, new[] { 1175, 190 } };
        var gapSamples = Rate * 40 / 1000;
        var frames = gapSamples * (steps.Length - 1);
        foreach (var step in steps) { frames += Rate * step[1] / 1000; }

        var pcm = new byte[frames * 2];
        var at = 0;
        for (var i = 0; i < steps.Length; i++)
        {
            var freq = steps[i][0];
            var tone = Rate * steps[i][1] / 1000;
            for (var n = 0; n < tone; n++)
            {
                // 起手 10 毫秒淡入、最后 40 毫秒淡出
                var env = Math.Min(Math.Min(1.0, n / (Rate * 0.01)), (tone - n) / (Rate * 0.04));
                var phase = 2 * Math.PI * freq * n / Rate;
                var v = (Math.Sin(phase) + 0.25 * Math.Sin(2 * phase)) / 1.25 * env * 0.28;
                var s = (short)Math.Round(v * short.MaxValue);
                pcm[at++] = (byte)(s & 0xFF);
                pcm[at++] = (byte)((s >> 8) & 0xFF);
            }
            if (i < steps.Length - 1) { at += gapSamples * 2; }
        }
        return WavOf(pcm);
    }

    /// <summary>给一段 16 位 PCM 套上 44 字节的 wav 头。</summary>
    private static byte[] WavOf(byte[] pcm)
    {
        var stream = new MemoryStream();
        var w = new BinaryWriter(stream);
        w.Write(Encoding.ASCII.GetBytes("RIFF"));
        w.Write(36 + pcm.Length);
        w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        w.Write(16);        // fmt 块长度
        w.Write((short)1);  // PCM
        w.Write((short)1);  // 单声道
        w.Write(Rate);
        w.Write(Rate * 2);  // 每秒字节数
        w.Write((short)2);  // 每帧字节数
        w.Write((short)16); // 位深
        w.Write(Encoding.ASCII.GetBytes("data"));
        w.Write(pcm.Length);
        w.Write(pcm);
        w.Flush();
        return stream.ToArray();
    }
}
