/*
 * notice —— 右下角那张「有事」的提醒卡片（Windows）。
 *
 * 干什么：哪个会话跑完了一轮、或者模型在那儿等你答一句，后端就把一条 show 写进它的标准输入，
 * 它在这台机器右下角画一张小卡片（最多三张叠着）。卡片可以点（后端据此打开那个会话的页面）、
 * 可以点右上角那颗 × 顺手关掉，后端也能说「这个会话已经说上话了 / 关掉了」把某一张收走。
 *
 * 为什么单独编一支小程序：安卓 app 与桌面小窗口都退休了，提醒不能跟着一起没。这支没有通知区域
 * 图标、没有主界面，只在有事的时候画卡片。后端一起来就把它拉起来（标准输入一直开着），
 * 它自己不会退；后端一退（标准输入关掉）它跟着收摊。没在 Windows 上、或者这支没编出来，
 * 后端就静悄悄地不弹，其余照常（浏览器页面里照样看得到）。
 *
 * 编法见 scripts/compile.mjs：用 Windows 自带的 csc.exe（.NET Framework）编成 bin/notice.exe，
 * 编译时带上 /codepage:65001（本文件是 UTF-8，不指明白 csc 会按系统代码页读，中文注释会乱）。
 * 这支用的是系统自带的 WinForms，一个第三方包都不引。
 *
 * 协议（一行一条，字段之间拿制表符隔开；标题、正文是 UTF-8 码的 base64，省得跟制表符打架）：
 *   后端写进来：
 *     show<TAB>标识<TAB>0|1<TAB>标题<TAB>正文     0 = 跑完一轮，1 = 在等你答一句
 *     close<TAB>标识                              把那一张收走（那个会话已经说上话了 / 关掉了）
 *     closeall                                    全收走
 *   它写出去：
 *     click<TAB>标识                              人点了那一张（后端据此打开那个会话）
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
        if (parts[0] == "closeall") { CloseAll(); }
    }

    private static void Show(string[] parts)
    {
        if (parts.Length < 5) { return; }
        var key = parts[1];
        var ask = parts[2] == "1";
        var title = Decode(parts[3]);
        var body = Decode(parts[4]);

        // 同一个会话反复推过来：换掉旧的（人看的是最新的那条）
        CloseKey(key);
        if (Cards.Count >= MaxCards)
        {
            Cards[0].CloseNow();
            Cards.RemoveAt(0);
        }

        var card = new NoticeCard(key, title, body, ask);
        card.Clicked += OnClicked;
        Cards.Add(card);
        card.Show();
        Arrange();
        Chime.Play(ask);
    }

    /// <summary>人点了哪一张：告诉后端（它去打开那个会话），这张收走。</summary>
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
    private static void CloseKey(string key)
    {
        for (var i = 0; i < Cards.Count; i++)
        {
            if (Cards[i].Key != key) { continue; }
            var card = Cards[i];
            Cards.RemoveAt(i);
            card.CloseNow();
            Arrange();
            return;
        }
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

    private static readonly Font TitleFont = new Font("Microsoft YaHei UI", 9.75f, FontStyle.Bold);
    private static readonly Font BodyFont = new Font("Microsoft YaHei UI", 9f);
    private static readonly Font CloseFont = new Font("Segoe UI", 12f);
    private static readonly Color TitleColor = Color.FromArgb(0x11, 0x18, 0x27);
    private static readonly Color BodyColor = Color.FromArgb(0x4B, 0x55, 0x63);
    private static readonly Color BorderColor = Color.FromArgb(0xD8, 0xDB, 0xE0);
    private static readonly Color CloseColor = Color.FromArgb(0x9A, 0xA3, 0xAF);
    private static readonly Color DoneColor = Color.FromArgb(0x2E, 0x7D, 0x32);
    private static readonly Color AskColor = Color.FromArgb(0xB2, 0x6A, 0x00);

    /// <summary>量正文高度时的上限（够放下三行以外的东西，量出来再截到三行）。</summary>
    private const int MeasureHeight = 4000;

    private readonly string heading;
    private string detail;
    private readonly bool asking;
    private readonly int headingHeight;
    private readonly int detailHeight;
    private Rectangle closeRect;
    private bool hoverClose;

    public string Key { get; private set; }
    public event Action<string> Clicked;

    public NoticeCard(string key, string title, string body, bool ask)
    {
        Key = key;
        heading = title ?? "";
        detail = body ?? "";
        asking = ask;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.White;
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);

        var textWidth = CardWidth - AccentWidth - PadX - PadX;
        headingHeight = TextRenderer.MeasureText(heading, TitleFont,
            new Size(textWidth, 1000), TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix).Height;
        var lineHeight = TextRenderer.MeasureText("国A", BodyFont).Height;
        var wanted = TextRenderer.MeasureText(detail, BodyFont,
            new Size(textWidth, MeasureHeight), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix).Height;
        detailHeight = Math.Min(wanted, lineHeight * MaxBodyLines);
        // TextRenderer 自动折行时不会替你加那个省略号（只把超出三行的截掉），自己截一刀补上
        if (wanted > detailHeight) { detail = Fit(detail, textWidth, detailHeight); }
        Size = new Size(CardWidth, PadY + headingHeight + TitleGap + detailHeight + PadY);
        closeRect = new Rectangle(Width - 26, 6, 18, 18);
    }

    /// <summary>把一段话截到装得进这么多高的地方，末尾加个省略号（截到只剩一个字也不再缩）。</summary>
    private static string Fit(string text, int width, int height)
    {
        var cut = text.Length;
        while (cut > 1)
        {
            cut = cut * 3 / 4;
            var candidate = text.Substring(0, cut).TrimEnd() + "…";
            var measured = TextRenderer.MeasureText(candidate, BodyFont,
                new Size(width, MeasureHeight), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix).Height;
            if (measured <= height) { return candidate; }
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
            cp.ExStyle |= 0x08000000 | 0x00000080;
            return cp;
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        closeRect = new Rectangle(Width - 26, 6, 18, 18);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var outline = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var fill = new SolidBrush(Color.White)) { g.FillRectangle(fill, outline); }
        using (var pen = new Pen(BorderColor)) { g.DrawRectangle(pen, outline); }

        // 左边那条竖线：一整条，从头到底，两头是平的（卡片没有圆角，不用担心被裁）
        using (var accent = new SolidBrush(asking ? AskColor : DoneColor))
        {
            g.FillRectangle(accent, 0, 0, AccentWidth + 1, Height);
        }

        var textX = AccentWidth + PadX;
        var textWidth = Width - textX - PadX;
        TextRenderer.DrawText(g, heading, TitleFont,
            new Rectangle(textX, PadY, textWidth, headingHeight), TitleColor,
            TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
            | TextFormatFlags.VerticalCenter);
        TextRenderer.DrawText(g, detail, BodyFont,
            new Rectangle(textX, PadY + headingHeight + TitleGap, textWidth, detailHeight), BodyColor,
            TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);

        TextRenderer.DrawText(g, "×", CloseFont, closeRect,
            hoverClose ? TitleColor : CloseColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var over = closeRect.Contains(e.Location);
        if (over != hoverClose)
        {
            hoverClose = over;
            Cursor = over ? Cursors.Default : Cursors.Hand;
            Invalidate(closeRect);
        }
        else if (!over)
        {
            Cursor = Cursors.Hand;
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoverClose)
        {
            hoverClose = false;
            Invalidate(closeRect);
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left) { return; }
        if (closeRect.Contains(e.Location))
        {
            Hub.Command("close\t" + Key);
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
