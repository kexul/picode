using System.Drawing;
using System.Drawing.Drawing2D;
using WinForms = System.Windows.Forms;

namespace PiChat;

/// <summary>
/// 通知区域里那颗图标（托盘）和它的右键菜单。
///
/// 以前这是一支单独的小程序（bin/tray.exe，后端用管道喂它），现在长在桌面这个小窗口里：
/// 后端起来时把它拉起来（只待在托盘里），左键点图标开主界面，右键三项 ——
/// 打开主界面 / 打开网页端 / 退出（退出跟终端里按 Ctrl+C 一样，整个后端收摊）。
///
/// 图标是照着那个标记现画的（跟以前一模一样：三块拼起来的方框，右下角一根红线）；
/// 它不表示有没有事，只是让人看得出「它在跑」。
/// </summary>
internal sealed class TrayUi : IDisposable
{
    private readonly WinForms.NotifyIcon _icon;
    private readonly WinForms.ContextMenuStrip _menu;
    private bool _disposed;

    /// <param name="onOpenMain">要主界面（左键点图标 / 菜单第一项）</param>
    /// <param name="onOpenWeb">打开网页端（菜单第二项）</param>
    /// <param name="onQuit">退出（菜单第三项）</param>
    public TrayUi(Action onOpenMain, Action onOpenWeb, Action onQuit)
    {
        _menu = new WinForms.ContextMenuStrip();
        var openMain = new WinForms.ToolStripMenuItem("打开主界面");
        openMain.Click += (_, _) => onOpenMain();
        var openWeb = new WinForms.ToolStripMenuItem("打开网页端");
        openWeb.Click += (_, _) => onOpenWeb();
        var quit = new WinForms.ToolStripMenuItem("退出");
        quit.Click += (_, _) => onQuit();
        _menu.Items.Add(openMain);
        _menu.Items.Add(openWeb);
        _menu.Items.Add(new WinForms.ToolStripSeparator());
        _menu.Items.Add(quit);

        _icon = new WinForms.NotifyIcon
        {
            Icon = MakeMark(),
            Text = "Pi Chat",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        // 左键：开主界面（右键才是菜单，NotifyIcon 自己管）
        _icon.MouseUp += (_, e) =>
        {
            if (e.Button == WinForms.MouseButtons.Left) { onOpenMain(); }
        };
    }

    /// <summary>鼠标停上去时那句提示（现在连着哪儿，看这里最省事）。</summary>
    public void SetStatus(string text)
    {
        if (_disposed) { return; }
        // NotifyIcon 的提示最多 63 个字（多了会被系统截断甚至报错），长的截一下
        _icon.Text = text.Length <= 63 ? text : text[..62] + "…";
    }

    public void Dispose()
    {
        if (_disposed) { return; }
        _disposed = true;
        try { _icon.Visible = false; } catch { /* 已经没了 */ }
        try { _icon.Dispose(); } catch { /* 已经没了 */ }
        try { _menu.Dispose(); } catch { /* 已经没了 */ }
    }

    /// <summary>那枚图标：三块拼起来的方框 + 右下角一根红线（跟以前那支小程序画的一样）。</summary>
    private static Icon MakeMark()
    {
        // 任务栏是浅色的就用深一点的标记，深色的就用浅一点的
        var ink = IsLightTaskbar() ? Color.FromArgb(0x11, 0x11, 0x11) : Color.FromArgb(0xF6, 0xF6, 0xF6);
        var red = Color.FromArgb(0xE5, 0x39, 0x35);
        var size = Math.Max(16, WinForms.SystemInformation.SmallIconSize.Width);

        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var brush = new SolidBrush(ink);
            using var bar = new SolidBrush(red);
            // 左上那一块（上面一条横条 + 右边一截）
            g.FillPolygon(brush, Poly(size, 420, 280, 280, 280, 280, 280, 140, 0, 140, 0, 0, 420, 0));
            // 右下角那根竖线
            g.FillPolygon(bar, Poly(size, 560, 560, 420, 560, 420, 280, 560, 280));
            // 左下那一块（阶梯状）
            g.FillPolygon(brush, Poly(size,
                140, 560, 0, 560, 0, 140, 140, 140, 140, 280, 280, 280, 280, 420, 140, 420));
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    /// <summary>把 560×560 那个方框里的坐标按比例缩到图标的边长上。</summary>
    private static Point[] Poly(int size, params int[] pairs)
    {
        var points = new Point[pairs.Length / 2];
        for (var i = 0; i < points.Length; i++)
        {
            points[i] = new Point(
                (int)Math.Round(pairs[i * 2] * size / 560.0),
                (int)Math.Round(pairs[i * 2 + 1] * size / 560.0));
        }
        return points;
    }

    /// <summary>任务栏是不是浅色的（决定标记画深色还是浅色）。</summary>
    private static bool IsLightTaskbar()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var value = key?.GetValue("SystemUsesLightTheme");
            return value is int number && number != 0;
        }
        catch
        {
            return true;
        }
    }
}
