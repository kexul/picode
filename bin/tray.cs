/*
 * tray —— 通知区域里那颗图标（Windows）。
 *
 * 干什么：后端起来时把它拉起来，图标就是“后端在跑”的招牌；右键弹一个小菜单：
 *   「打开」——让后端用浏览器打开那个页面（跟后端自己 --open 走同一段代码，开成没有标签条的应用窗口）；
 *   「退出」——让后端按 Ctrl+C 那套收摊退出（终端里起的那个版本退出后终端还在）。
 * 双击图标也是「打开」。
 *
 * 为什么单独一支小程序：托盘图标得住在一个有窗口消息循环的进程里（.NET 的 NotifyIcon），
 * 后端（Node）那边没有这个东西，只能起这么一支把图标端着。后端退出 → 这支进程的 stdin 关闭 →
 * 自己退出，不留孤儿。
 *
 * 编法见 scripts/compile.mjs（跟 bin/notice.cs 一样用系统自带的 csc.exe，
 * 只是这里用 -target:winexe，免得弹一个黑框）。
 *
 * 协议：一行一条，字段之间用制表符分开，UTF-8。
 *   后端 → 这里：
 *     url \t 地址      网页服务现在的地址（菜单里「打开」交给后端去开，这里只用它决定那颗能不能点）
 *   stdin 关了就是收摊（后端退出时不一定来得及说一声）
 *   这里 → 后端：
 *     open             菜单里点了「打开」（或双击了图标）
 *     exit             菜单里点了「退出」
 */
using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
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
        // 按屏幕的缩放画：不声明的话，高 DPI 屏上图标会被系统拉伸成模糊的小图
        try { SetProcessDPIAware(); }
        catch { /* 老系统没这个函数，就当没有 */ }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayContext());
    }
}

/** 任务栏是浅色的吗（浅色面板上用深色标记）。读不到就当深色。 */
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

class TrayContext : ApplicationContext
{
    /** 从 stdin 收命令的节奏：这么多个毫秒看一次有没有新的一行。 */
    private const int PUMP_MS = 80;

    private readonly NotifyIcon icon = new NotifyIcon();
    /** 那枚图标：标记照原色，右下角那根竖线一直是红的。 */
    private readonly Icon mark;
    private readonly System.Windows.Forms.Timer pump = new System.Windows.Forms.Timer();
    private readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
    private bool closing;
    /** 菜单里已经点过「退出」了：别再发一遍。 */
    private bool askedExit;
    /** 网页服务的地址（后端告诉的）：不知道就是空，菜单里「打开」点不动。 */
    private string pageUrl = "";
    /** 菜单里那颗「打开」：知道地址以后才点得动。 */
    private readonly ToolStripMenuItem openItem;
    /** 往后端写字的管子（点了「打开」「退出」都会用到）。 */
    private StreamWriter toBackend;
    /** 写管子的锁：读 stdin 的线程、点菜单的界面线程两边都要写。 */
    private readonly object outLock = new object();

    public TrayContext()
    {
        // 任务栏是浅色的就用深一点的标记，深色的就用浅一点的（跟页面里那个 SVG 一个意思）
        Color ink = Theme.IsLight() ? Color.FromArgb(0x11, 0x11, 0x11) : Color.FromArgb(0xF6, 0xF6, 0xF6);
        Color red = Color.FromArgb(0xE5, 0x39, 0x35);
        int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
        mark = MakeMark(size, ink, red);

        icon.Icon = mark;
        icon.Text = "Pi Chat";
        // 右键弹菜单（左键双击也是「打开」）：两项 —— 打开、退出
        ContextMenuStrip menu = new ContextMenuStrip();
        openItem = new ToolStripMenuItem("打开");
        openItem.Enabled = false;      // 地址还没来：等后端说（见 Handle 里的 url）
        openItem.Click += delegate { OpenPage(); };
        menu.Items.Add(openItem);
        menu.Items.Add(new ToolStripSeparator());
        ToolStripMenuItem quit = new ToolStripMenuItem("退出");
        quit.Click += delegate { AskExit(); };
        menu.Items.Add(quit);
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += delegate { OpenPage(); };
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
            case "quit":
                Quit();
                return;
            case "url":
            {
                // 后端说网页服务在哪个地址：记下（「打开」那颗就点得动了），不弹任何东西
                pageUrl = parts.Length > 1 ? parts[1].Trim() : "";
                if (openItem != null) { openItem.Enabled = pageUrl.Length > 0; }
                return;
            }
        }
    }

    /** 菜单里点了「打开」：让后端去开（它会开成没有标签条的应用窗口）。 */
    private void OpenPage()
    {
        if (pageUrl.Length == 0) { return; }
        SendLine("open");
    }

    /**
     * 菜单里点了「退出」：跟后端说一声（它收到就去收摊，收摊时把我们的 stdin 关掉，
     * 这边读到结尾就自己退，见 Quit）。这一步只发话、不自己退：后端还没收摊
     * 就把图标收了的话，人看不出到底退没退。
     */
    private void AskExit()
    {
        if (askedExit) { return; }
        askedExit = true;
        SendLine("exit");
    }

    /** 往后端写一行（两处会写：点了「打开」、点了「退出」）；管子断了就当后端已经没了。 */
    private void SendLine(string line)
    {
        try
        {
            lock (outLock)
            {
                if (toBackend == null)
                {
                    toBackend = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                }
                toBackend.WriteLine(line);
                toBackend.Flush();
            }
        }
        catch
        {
            // 管子断了：后端多半已经没了，那这边下一次读也会读到结尾
        }
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
        }
        catch { }
        ExitThread();
    }
}
