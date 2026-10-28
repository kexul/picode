/*
 * tray —— 通知区域里那颗图标（Windows）。
 *
 * 干什么：后端有事（某个会话跑完一轮、模型在等你答一道选择题）时，在 Windows 通知区域里
 * 闪一颗图标；点它就弹出清单，列着哪几个会话有事，点其中一行把界面切到那个会话。
 *
 * 为什么单独一个常驻小程序：托盘图标得住在一个有窗口消息循环的进程里（.NET 的 NotifyIcon），
 * 后端（Node）那边没有这个东西，只能起这么一个把图标端着。后端退出 → 这个进程的 stdin
 * 关闭 → 自己退出，不留孤儿。
 *
 * 跟浏览器通知那条路没有关系，也不用问谁要权限：图标是我们自己进程里的。
 * 图标就是那个标记（三块拼出来的方框）；有事的时候，右下角那根竖线变成红色、一闪一闪。
 * Windows 没有“让托盘图标闪”的现成接口，闪是自己定时换图标，每 600 毫秒换一次。
 *
 * 编法见 scripts/compile.mjs（跟 bin/shot.cs 一样用系统自带的 csc.exe，
 * 只是这里用 -target:winexe，免得弹一个黑框）。
 *
 * 协议：一行一条，字段之间用制表符分开，两边都是 UTF-8。
 *   后端 → 这里：
 *     list \t 标识 \t 名字 \t 标识 \t 名字 …   有事的清单（空就只发一个 list）：非空开始闪，空就停
 *     quit                                   收摊退出（后端退出时不一定来得及发，stdin 关了也算）
 *   这里 → 后端：
 *     pick \t 标识   清单里点了那一行
 *     open           点了「打开页面」
 *     quit           点了「退出这颗图标」
 */
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayContext());
    }
}

/**
 * 一个看不见的小窗口，只用来给原生菜单当主人（TrackPopupMenuEx 要一个窗口句柄）。
 */
class InvisibleForm : Form
{
    /** 弹出来那一下不抢焦点：人在别的窗口里打字，别被这颗图标打断。 */
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }
}

/** 一颗托盘图标 + 它的菜单 + 跟后端说话的那两头。 */
class TrayContext : ApplicationContext
{
    /** 闪的节奏：这么多个毫秒换一次图标。 */
    private const int BLINK_MS = 600;
    /** 从 stdin 收命令的节奏：这么多个毫秒看一次有没有新的一行。 */
    private const int PUMP_MS = 80;
    /** 左键点图标后隔这么久再弹菜单（等“隐藏的图标”那一格自己关掉，见 openMenu）。 */
    private const int MENU_DELAY_MS = 300;
    /** 菜单里那两行的编号（会话那几行用 1、2、3…，撞不上）。 */
    private const int CMD_OPEN = 9001;
    private const int CMD_QUIT = 9002;
    private const uint MF_STRING = 0x00000000;
    private const uint MF_GRAYED = 0x00000001;
    private const uint MF_SEPARATOR = 0x00000800;
    private const uint TPM_RETURNCMD = 0x0100;
    private const uint TPM_RIGHTBUTTON = 0x0002;
    private const uint TPM_NONOTIFY = 0x0080;
    private const uint WM_NULL = 0x0000;

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenuW(IntPtr hMenu, uint flags, UIntPtr id, string text);
    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(IntPtr hMenu);
    [DllImport("user32.dll")]
    private static extern int TrackPopupMenuEx(IntPtr hMenu, uint flags, int x, int y, IntPtr hWnd, IntPtr reserved);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

    private readonly NotifyIcon icon = new NotifyIcon();
    /** 没事时候的图标：标记照原色，右下角那根竖线也是。 */
    private readonly Icon idleIcon;
    /** 有事时的两枚：竖线是正红 / 竖线红得淡一点，两枚交替着换就是“闪”。 */
    private readonly Icon alertIcon;
    private readonly Icon alertDimIcon;
    private readonly System.Windows.Forms.Timer blink = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer pump = new System.Windows.Forms.Timer();
    /**
     * 左键点图标后推迟一点再弹菜单。
     * 图标落在 Windows 11“隐藏的图标”那一格里时，鼠标一抬那一格就关，同步弹的菜单也跟着
     * 被关掉；等它关完再弹才看得见。
     */
    private readonly System.Windows.Forms.Timer openMenu = new System.Windows.Forms.Timer();
    /** 弹菜单的位置：点的那一瞬间的光标位置。 */
    private Point menuAt;
    /** 原生菜单的主人窗口（一个看不见的小窗口，见 InvisibleForm）。 */
    private readonly InvisibleForm menuOwner;
    private readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
    /** 有事的清单：每项两格 { 标识, 名字 }。 */
    private readonly List<string[]> pending = new List<string[]>();
    private readonly StreamWriter toBackend;
    private bool blinking;
    private bool lit;
    private bool closing;

    public TrayContext()
    {
        // 任务栏是浅色的就用深一点的标记，深色的就用浅一点的（跟那个 SVG 里 prefers-color-scheme 一个意思）
        Color mark = TaskbarIsLight() ? Color.FromArgb(0x11, 0x11, 0x11) : Color.FromArgb(0xF6, 0xF6, 0xF6);
        Color red = Color.FromArgb(0xE5, 0x39, 0x35);
        int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
        idleIcon = MakeMark(size, mark, mark);
        alertIcon = MakeMark(size, mark, red);
        alertDimIcon = MakeMark(size, mark, Color.FromArgb(110, red));

        icon.Icon = idleIcon;
        icon.Text = "Pi Chat：没有新消息";
        icon.Visible = true;
        // 菜单得有个主人窗口：TrackPopupMenu 要一个窗口句柄，点菜单外面收掉也靠它
        menuOwner = new InvisibleForm();
        menuOwner.ShowInTaskbar = false;
        menuOwner.FormBorderStyle = FormBorderStyle.None;
        menuOwner.StartPosition = FormStartPosition.Manual;
        menuOwner.Bounds = new Rectangle(-32000, -32000, 1, 1);
        // 全透明：它只用来当菜单的主人，不该被人看见
        menuOwner.Opacity = 0;
        menuOwner.Show();
        // 左键、右键都弹同一份菜单
        icon.MouseClick += (s, e) =>
        {
            if (e.Button != MouseButtons.Left && e.Button != MouseButtons.Right) { return; }
            menuAt = Cursor.Position;
            openMenu.Start();
        };

        blink.Interval = BLINK_MS;
        blink.Tick += (s, e) => ToggleBlink();
        pump.Interval = PUMP_MS;
        pump.Tick += (s, e) => Drain();
        pump.Start();
        openMenu.Interval = MENU_DELAY_MS;
        openMenu.Tick += (s, e) =>
        {
            openMenu.Stop();
            try { ShowMenu(); }
            catch { /* 弹不出来就当没点 */ }
        };

        // 后端那边是管道，用明确的 UTF-8 读写，不指望控制台的代码页
        toBackend = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        toBackend.AutoFlush = true;
        Thread reader = new Thread(ReadStdin) { IsBackground = true };
        reader.Start();
    }

    /**
     * 画一枚图标：那个标记（三块拼起来的方框），右下角那根竖线用它自己的颜色。
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
                    // 右下角那根竖线：有事的时候就是它变红、闪
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

    /** 任务栏是浅色的吗（浅色任务栏上不能用白标记，看不清）。读不到就当深色。 */
    private static bool TaskbarIsLight()
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
            case "list":
                SetPending(parts);
                return;
            case "quit":
                Quit();
                return;
        }
    }

    /** 后端把整份清单重发一遍：非空开始闪，空就停。 */
    private void SetPending(string[] parts)
    {
        pending.Clear();
        for (int i = 1; i + 1 < parts.Length; i += 2)
        {
            pending.Add(new string[] { parts[i], parts[i + 1] });
        }
        if (pending.Count > 0) { StartBlink(); } else { StopBlink(); }
        icon.Text = Shorten(pending.Count > 0 ? "Pi Chat：" + pending.Count + " 个会话有事" : "Pi Chat：没有新消息");
    }

    private void StartBlink()
    {
        // 已经在闪就接着闪，别把节奏重置了
        if (blinking) { return; }
        blinking = true;
        lit = false;
        ToggleBlink();
        blink.Start();
    }

    private void StopBlink()
    {
        blinking = false;
        blink.Stop();
        icon.Icon = idleIcon;
    }

    private void ToggleBlink()
    {
        lit = !lit;
        icon.Icon = lit ? alertIcon : alertDimIcon;
    }

    /** 在光标那里弹菜单：上面是「哪几个会话有事」，下面是「打开页面 / 退出这颗图标」。 */
    private void ShowMenu()
    {
        // 用系统的原生菜单（TrackPopupMenuEx），不用 WinForms 的 ContextMenuStrip：
        // 那种菜单在这种没有主窗口、没人点过界面就能弹的程序里，常常一冒头就自己收回去。
        IntPtr hmenu = CreatePopupMenu();
        try
        {
            List<string> ids = new List<string>();
            if (pending.Count == 0)
            {
                AppendMenuW(hmenu, MF_GRAYED, UIntPtr.Zero, "没有要看的事");
            }
            else
            {
                foreach (string[] item in pending)
                {
                    ids.Add(item[0]);
                    AppendMenuW(hmenu, MF_STRING, new UIntPtr((uint)ids.Count), item[1]);
                }
            }
            AppendMenuW(hmenu, MF_SEPARATOR, UIntPtr.Zero, null);
            AppendMenuW(hmenu, MF_STRING, new UIntPtr(CMD_OPEN), "打开页面");
            AppendMenuW(hmenu, MF_STRING, new UIntPtr(CMD_QUIT), "退出这颗图标");

            // 不先把主人窗口弄到前台，点菜单外面它不会自己收掉
            SetForegroundWindow(menuOwner.Handle);
            int cmd = TrackPopupMenuEx(hmenu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
                menuAt.X, menuAt.Y, menuOwner.Handle, IntPtr.Zero);
            PostMessageW(menuOwner.Handle, WM_NULL, IntPtr.Zero, IntPtr.Zero);

            if (cmd <= 0) { return; }
            if (cmd == CMD_OPEN) { Emit("open"); return; }
            if (cmd == CMD_QUIT) { Quit(); return; }
            if (cmd <= ids.Count) { Emit("pick	" + ids[cmd - 1]); }
        }
        finally
        {
            DestroyMenu(hmenu);
        }
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
        Emit("quit");
        try
        {
            blink.Stop();
            pump.Stop();
            openMenu.Stop();
            icon.Visible = false;
            icon.Dispose();
        }
        catch { }
        ExitThread();
    }

    /** 托盘提示最多一两行字，长了系统不肯显示。 */
    private static string Shorten(string text)
    {
        return text.Length <= 60 ? text : text.Substring(0, 59) + "…";
    }
}
