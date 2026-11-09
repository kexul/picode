/*
 * resize —— 把一张图缩一缩、换成 JPEG 的独立小程序（Windows）。
 *
 * 干什么：会话里的工具结果图（截图居多）整张 base64 发给页面，一张 2560×1440 的 PNG
 * 就是两三 MB，手机上走流量看一眼要等好久。插件后端（见 src/imageFit.ts）把图从标准输入
 * 交给它：缩到长边上限以内、按质量编成 JPEG，base64 从标准输出回来，不落盘。
 *
 * 为什么要单独编一个小程序：跟 bin/shot.cs 一个道理 —— 要在服务端解码 / 缩放 / 编码图片，
 * 而 Node 里没有现成的编码器（仓库一个运行期依赖都没有）。Windows 自带的 GDI+ 干这个又快又稳；
 * 别的系统上不缩图，照原样发（见 src/imageFit.ts 的说明，那边只是少省几百 KB，不会坏）。
 *
 * 编法见 scripts/compile.mjs：用 Windows 自带的 csc.exe（.NET Framework）编成 bin/resize.exe，
 * 编译时带上 /codepage:65001（本文件是 UTF-8，不指明白 csc 会按系统代码页读，中文注释会乱）。
 *
 * 用法：resize.exe <长边上限> <JPEG 质量 1~100>
 *   图片的 base64 从标准输入读（不换行也行，带换行也行）
 *   成功：JPEG 的 base64 打到标准输出（不换行、不带别的字），退出码 0
 *   失败：往标准错误写一句人话，退出码 1
 */
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class Resize
{
    static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2)
            {
                throw new Exception("用法：resize.exe <长边上限> <JPEG 质量>，图片 base64 从标准输入读");
            }
            int maxEdge = int.Parse(args[0]);
            long quality = long.Parse(args[1]);
            if (maxEdge < 16 || maxEdge > 20000)
            {
                throw new Exception("长边上限不合理：" + maxEdge);
            }
            if (quality < 1 || quality > 100)
            {
                throw new Exception("质量不合理：" + quality);
            }

            string text = Console.In.ReadToEnd();
            // 管道里可能带着换行（调用方怎么方便怎么给）
            text = text.Replace("\r", "").Replace("\n", "").Trim();
            if (text.Length == 0)
            {
                throw new Exception("标准输入是空的（要的是图片的 base64）");
            }
            byte[] raw = Convert.FromBase64String(text);

            using (MemoryStream input = new MemoryStream(raw))
            using (Image source = Image.FromStream(input))
            {
                int width = source.Width;
                int height = source.Height;
                if (width <= 0 || height <= 0)
                {
                    throw new Exception("这张图的尺寸读不出来");
                }
                int longEdge = Math.Max(width, height);
                // 本来就没超上限：尺寸不动，只是重新编一次（PNG → JPEG 本身就小很多）
                int w = width;
                int h = height;
                if (longEdge > maxEdge)
                {
                    double scale = (double)maxEdge / longEdge;
                    w = Math.Max(1, (int)Math.Round(width * scale));
                    h = Math.Max(1, (int)Math.Round(height * scale));
                }

                // 白底：JPEG 没有透明通道，直接编会把透明的地方变成黑的（界面上看着像一块脏东西）
                using (Bitmap canvas = new Bitmap(w, h))
                {
                    using (Graphics g = Graphics.FromImage(canvas))
                    {
                        g.Clear(Color.White);
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(source, new Rectangle(0, 0, w, h));
                    }
                    ImageCodecInfo jpeg = null;
                    foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
                    {
                        if (codec.FormatID == ImageFormat.Jpeg.Guid) { jpeg = codec; break; }
                    }
                    if (jpeg == null) { throw new Exception("这台机器上没有 JPEG 编码器"); }
                    using (EncoderParameters ps = new EncoderParameters(1))
                    {
                        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                        using (MemoryStream output = new MemoryStream())
                        {
                            canvas.Save(output, jpeg, ps);
                            Console.Out.Write(Convert.ToBase64String(output.ToArray()));
                        }
                    }
                }
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.Write(e.Message);
            return 1;
        }
    }
}
