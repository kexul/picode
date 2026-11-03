/*
 * live —— 一直拍桌面的小表（Windows）。
 *
 * 干什么：每隔一个间隔拍一张当前桌面（所有显示器拼成的那一整块），缩到长边上限以内，
 * 压成 JPEG，一帧一帧打到标准输出。插件后端（见 src/desktopLive.ts）拿它当
 * 「长按截图按钮看桌面实时画面」的那双手。
 *
 * 为什么不能像截图那样一次起一个进程：那个小程序拍一张就退，一次 140ms 的启动开销，
 * 一秒两张就是白烧三成时间，还每秒起一次进程。这支一直待着，抓屏、缩小、编码都在一个进程里做。
 *
 * 画面没变就不发这一帧：桌面多半时间是静的（没人在动），发同样的图白占流量；
 * 比的是缩完之后那张图的像素（不是编码后的 JPEG），省掉编码这一趟。
 *
 * 编法见 scripts/compile.mjs：用 Windows 自带的 csc.exe（.NET Framework）编成 bin/live.exe，
 * 编译时带上 /codepage:65001（本文件是 UTF-8，不指明白 csc 会按系统代码页读，中文注释会乱）。
 *
 * 用法：live.exe [长边上限=512] [间隔毫秒=500] [JPEG 质量=60]
 *   每一帧：4 字节大端长度 + JPEG 原文，一帧接一帧，打完就刷出去
 *   失败：往标准错误写一句人话，退出码 1
 *   停：后端把标准输入关掉（或者直接杀进程）就退出
 */
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class Live
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
            int maxEdge = 512;
            int intervalMs = 500;
            int quality = 60;
            if (args.Length > 0) { maxEdge = int.Parse(args[0]); }
            if (args.Length > 1) { intervalMs = int.Parse(args[1]); }
            if (args.Length > 2) { quality = int.Parse(args[2]); }
            if (maxEdge <= 0) { throw new Exception("长边上限得是个正数。"); }
            if (intervalMs <= 0) { throw new Exception("间隔得是个正数。"); }
            if (quality < 10 || quality > 100) { throw new Exception("质量得在 10 到 100 之间。"); }
            StopWhenStdinCloses();
            Run(maxEdge, intervalMs, quality);
            return 0;
        }
        catch (Exception err)
        {
            Console.Error.Write("桌面实时画面失败：" + err.Message);
            return 1;
        }
    }

    /** 后端不要了就把标准输入关掉：读到末尾就退出（它杀进程也行，这条路只是收得干净些）。 */
    private static void StopWhenStdinCloses()
    {
        Thread watcher = new Thread(delegate()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] sink = new byte[64];
                while (input.Read(sink, 0, sink.Length) > 0) { }
            }
            catch { /* 读不了就当它关了 */ }
            Environment.Exit(0);
        });
        watcher.IsBackground = true;
        watcher.Start();
    }

    private static void Run(int maxEdge, int intervalMs, int quality)
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

        int longEdge = Math.Max(width, height);
        double scale = longEdge > maxEdge ? (double)maxEdge / longEdge : 1.0;
        int smallWidth = Math.Max(1, (int)Math.Round(width * scale));
        int smallHeight = Math.Max(1, (int)Math.Round(height * scale));

        ImageCodecInfo jpeg = JpegCodec();
        Stream output = Console.OpenStandardOutput();
        byte[] lastSent = null;   // 上一次真发出去的那张（缩完之后的像素）
        byte[] scratch = null;

        using (Bitmap full = new Bitmap(width, height))
        using (Bitmap small = new Bitmap(smallWidth, smallHeight))
        using (Graphics fullGraphics = Graphics.FromImage(full))
        using (Graphics smallGraphics = Graphics.FromImage(small))
        {
            smallGraphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            using (EncoderParameters encoder = new EncoderParameters(1))
            {
                encoder.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                while (true)
                {
                    int started = Environment.TickCount;
                    fullGraphics.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                    smallGraphics.DrawImage(full, 0, 0, smallWidth, smallHeight);
                    scratch = ReadPixels(small, scratch);
                    if (lastSent == null || !SamePixels(lastSent, scratch))
                    {
                        WriteFrame(output, Encode(small, jpeg, encoder));
                        byte[] swap = lastSent;
                        lastSent = scratch;
                        scratch = swap;
                    }
                    // 这一张花掉的时间从间隔里扣掉：慢的时候就是慢，不额外再等一个整间隔
                    int spent = Environment.TickCount - started;
                    if (intervalMs > spent) { Thread.Sleep(intervalMs - spent); }
                }
            }
        }
    }

    /** 按 JPEG 编码一张图（质量由调用方给）。 */
    private static byte[] Encode(Bitmap bmp, ImageCodecInfo jpeg, EncoderParameters encoder)
    {
        using (MemoryStream buffer = new MemoryStream())
        {
            bmp.Save(buffer, jpeg, encoder);
            return buffer.ToArray();
        }
    }

    /** 把一帧写到标准输出：4 字节大端长度 + JPEG 原文，写完立刻刷出去（不然攒在缓冲区里看不见）。 */
    private static void WriteFrame(Stream output, byte[] jpegBytes)
    {
        int length = jpegBytes.Length;
        byte[] header = new byte[] {
            (byte)(length >> 24), (byte)(length >> 16), (byte)(length >> 8), (byte)length,
        };
        output.Write(header, 0, header.Length);
        output.Write(jpegBytes, 0, jpegBytes.Length);
        output.Flush();
    }

    /** 把一张图的像素抄进数组（复用一个够大的数组，别每帧都新申请几 MB）。 */
    private static byte[] ReadPixels(Bitmap bmp, byte[] buffer)
    {
        BitmapData data = bmp.LockBits(
            new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int need = data.Stride * data.Height;
            if (buffer == null || buffer.Length != need) { buffer = new byte[need]; }
            Marshal.Copy(data.Scan0, buffer, 0, need);
            return buffer;
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    /** 两张图（同样的大小）是不是一模一样。 */
    private static bool SamePixels(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) { return false; }
        for (int i = 0; i < a.Length; i++)
        {
            if (a[i] != b[i]) { return false; }
        }
        return true;
    }

    /** 系统里 JPEG 那份编码器的信息（质量要靠它才给得出去）。 */
    private static ImageCodecInfo JpegCodec()
    {
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.FormatID == ImageFormat.Jpeg.Guid) { return codec; }
        }
        throw new Exception("系统里找不到 JPEG 编码器。");
    }
}
