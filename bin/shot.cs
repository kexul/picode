/*
 * shot —— 截一张桌面（Windows）的独立小程序。
 *
 * 干什么：把当前桌面（所有显示器拼成的那一整块）拍下来，缩到长边 1600 以内，
 * 存成 JPEG 并把 base64 打到标准输出。插件后端（见 src/desktopScreenshot.ts）拿它当
 * 「桌面截图」按钮的那双手。
 *
 * 为什么要单独编一个小程序：每次现起一个 PowerShell 截屏，光启动（240ms）加载程序集、
 * 现场编译那段 DPI 声明的 C#（70ms）就要 300ms，加上抓屏本身，一次 450ms 起步；
 * 这个 exe 起一次只要 140ms。抓屏、缩小、编码的做法与原来那版 PowerShell 脚本一字不差。
 *
 * 编法见 scripts/compile.mjs：用 Windows 自带的 csc.exe（.NET Framework）编成 bin/shot.exe，
 * 编译时带上 /codepage:65001（本文件是 UTF-8，不指明白 csc 会按系统代码页读，中文注释会乱）。
 *
 * 用法：shot.exe [长边上限，默认 1600]
 *   成功：base64 打到标准输出（不换行、不带别的字）
 *   失败：往标准错误写一句人话，退出码 1
 */
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

class Shot
{
    // 声明进程 DPI 感知：不声明的话，高分屏（缩放 125% / 150% 那些）上截出来
    // 是被系统缩小过的模糊图。必须在真正取屏幕尺寸之前调用。
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    // 取屏幕尺寸用（虚拟桌面，见下面那几个编号）
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    // GetSystemMetrics 认识的那几个编号：虚拟桌面（所有显示器拼起来那一整块）的边界
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    private static int Main(string[] args)
    {
        try
        {
            int maxEdge = 1600;
            if (args.Length > 0)
            {
                maxEdge = int.Parse(args[0]);
                if (maxEdge <= 0) { throw new Exception("长边上限得是个正数。"); }
            }
            Console.Out.Write(Capture(maxEdge));
            return 0;
        }
        catch (Exception err)
        {
            Console.Error.Write("桌面截图失败：" + err.Message);
            return 1;
        }
    }

    /** 抓一张桌面，返回 JPEG 的 base64 文本。 */
    private static string Capture(int maxEdge)
    {
        SetProcessDPIAware();
        int x = GetSystemMetrics(SmXVirtualScreen);
        int y = GetSystemMetrics(SmYVirtualScreen);
        int width = GetSystemMetrics(SmCxVirtualScreen);
        int height = GetSystemMetrics(SmCyVirtualScreen);
        // 屏幕锁定、远程会话断开、没有交互桌面时会读到 0
        if (width <= 0 || height <= 0)
        {
            throw new Exception("读不到屏幕尺寸（屏幕锁定或远程会话断开时可能这样）。");
        }

        using (Bitmap bmp = new Bitmap(width, height))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(width, height));
            }
            // 长边超过上限就等比缩小：4K / 多屏的原图又大又慢，看一眼桌面用不着全分辨率
            Bitmap shot = bmp;
            Bitmap small = null;
            try
            {
                int longEdge = Math.Max(width, height);
                if (longEdge > maxEdge)
                {
                    double scale = (double)maxEdge / longEdge;
                    int w = (int)Math.Round(width * scale);
                    int h = (int)Math.Round(height * scale);
                    small = new Bitmap(w, h);
                    using (Graphics g2 = Graphics.FromImage(small))
                    {
                        g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g2.DrawImage(bmp, 0, 0, w, h);
                    }
                    shot = small;
                }
                using (MemoryStream ms = new MemoryStream())
                {
                    shot.Save(ms, ImageFormat.Jpeg);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
            finally
            {
                if (small != null) { small.Dispose(); }
            }
        }
    }
}
