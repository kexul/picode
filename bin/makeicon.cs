/*
 * makeicon —— 给单文件 exe 做图标（只在打包 exe 时用，见 scripts/build-exe.mjs）。
 *
 *   makeicon.exe write  <输出.ico>         把项目那个标记画成 .ico（16 / 20 / 24 / 32 / 40 / 48 / 64 / 128 / 256 九种尺寸）
 *   makeicon.exe embed  <exe> <ico>        把 ico 写进 exe 的资源表（RT_ICON + RT_GROUP_ICON，组号 1）
 *
 * 为什么要写这一支：exe 的图标是 PE 资源表里的东西，Node 单文件那套不管它，资源管理器里
 * 就还是 Node 那个默认图标。改图标有两条路：拿 VS 的 editbin/rcedit，或者自己调两个 Win32 接口
 * （BeginUpdateResource / UpdateResource / EndUpdateResource）。我们在 Windows 上已经靠系统自带的
 * csc.exe 编小程序了（bin/shot.cs、bin/tray.cs），这条一样走它，不用为打包再拉一个依赖进来。
 *
 * 注意顺序：**必须**在 blob 注入之后做。BeginUpdateResource 带“删掉现有资源”会把
 * 注入进去的 NODE_SEA_BLOB 一起抹掉（exe 就变成一份普通的 node 了）；所以这里是覆盖式写入，
 * 不动别的资源。
 */
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

static class MakeIcon
{
    /** 打标记用的九种尺寸（Windows 会按场合挑一个最合适的）。 */
    private static readonly int[] Sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "write") { WriteIcon(args[1]); return 0; }
            if (args.Length == 3 && args[0] == "embed") { EmbedIcon(args[1], args[2]); return 0; }
            Console.Error.WriteLine("用法：makeicon write <输出.ico> | makeicon embed <exe> <ico>");
            return 2;
        }
        catch (Exception err)
        {
            Console.Error.WriteLine(err.Message);
            return 1;
        }
    }

    // ---- 画：一个圆角方块（浅色）+ 那个标记（深色） ----
    // 为什么这么配：文件图标要同时出现在浅色与深色背景上，纯标记（深色）在深色背景上会看不见；
    // 一块浅色的底再挖出深色标记，两种背景都认得出。

    /** 那个标记的三块（原图是 560×560 的方框），坐标照抄 bin/tray.cs。 */
    private static readonly int[][] MarkParts =
    {
        new[] { 420, 280, 280, 280, 280, 140, 0, 140, 0, 0, 420, 0 },
        new[] { 560, 560, 420, 560, 420, 280, 560, 280 },
        new[] { 140, 560, 0, 560, 0, 140, 140, 140, 140, 280, 280, 280, 280, 420, 140, 420 },
    };

    private static Bitmap Render(int size)
    {
        Bitmap bmp = new Bitmap(size, size);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            // 圆角底：半径按边长算，小尺寸上别把角吃掉太多
            float radius = Math.Max(1f, size * 0.22f);
            using (GraphicsPath path = RoundedRect(new RectangleF(0.5f, 0.5f, size - 1f, size - 1f), radius))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(0xF6, 0xF6, 0xF6)))
            using (Pen edge = new Pen(Color.FromArgb(0x30, 0x30, 0x30), Math.Max(0.6f, size / 48f)))
            {
                g.FillPath(fill, path);
                g.DrawPath(edge, path);
            }
            // 标记：在方块里留一圈边距再画
            float inset = size * 0.16f;
            float scale = (size - inset * 2f) / 560f;
            g.TranslateTransform(inset, inset);
            using (SolidBrush ink = new SolidBrush(Color.FromArgb(0x11, 0x11, 0x11)))
            {
                foreach (int[] part in MarkParts) { g.FillPolygon(ink, Scalepoints(part, scale)); }
            }
            g.ResetTransform();
        }
        return bmp;
    }

    private static GraphicsPath RoundedRect(RectangleF rect, float radius)
    {
        float d = radius * 2f;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static PointF[] Scalepoints(int[] pairs, float scale)
    {
        PointF[] points = new PointF[pairs.Length / 2];
        for (int i = 0; i < points.Length; i++)
        {
            points[i] = new PointF(pairs[i * 2] * scale, pairs[i * 2 + 1] * scale);
        }
        return points;
    }

    // ---- 写成 .ico（每一档都是一张 PNG，Vista 以后都认这个写法） ----
    private static void WriteIcon(string file)
    {
        List<byte[]> images = new List<byte[]>();
        foreach (int size in Sizes)
        {
            using (Bitmap bmp = Render(size))
            using (MemoryStream mem = new MemoryStream())
            {
                bmp.Save(mem, ImageFormat.Png);
                images.Add(mem.ToArray());
            }
        }
        using (FileStream outFile = File.Create(file))
        using (BinaryWriter w = new BinaryWriter(outFile))
        {
            w.Write((ushort)0);              // reserved
            w.Write((ushort)1);              // type: 1 = 图标
            w.Write((ushort)Sizes.Length);   // 几张
            int offset = 6 + 16 * Sizes.Length;
            for (int i = 0; i < Sizes.Length; i++)
            {
                int size = Sizes[i];
                w.Write((byte)(size >= 256 ? 0 : size));   // 宽（256 写 0）
                w.Write((byte)(size >= 256 ? 0 : size));   // 高
                w.Write((byte)0);                          // 调色板数
                w.Write((byte)0);                          // 保留
                w.Write((ushort)1);                        // 色面
                w.Write((ushort)32);                       // 每像素位数
                w.Write(images[i].Length);
                w.Write(offset);
                offset += images[i].Length;
            }
            foreach (byte[] image in images) { w.Write(image); }
        }
    }

    // ---- 写进 exe 的资源表 ----
    private const int RT_ICON = 3;
    private const int RT_GROUP_ICON = 14;
    private const ushort LANG_NEUTRAL = 0;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    private static void EmbedIcon(string exe, string ico)
    {
        // 读 ico：拆出每一张的原始字节与尺寸
        byte[] raw = File.ReadAllBytes(ico);
        int count = BitConverter.ToUInt16(raw, 4);
        List<byte[]> images = new List<byte[]>();
        List<int> widths = new List<int>();
        for (int i = 0; i < count; i++)
        {
            int at = 6 + 16 * i;
            int width = raw[at] == 0 ? 256 : raw[at];
            int length = BitConverter.ToInt32(raw, at + 8);
            int offset = BitConverter.ToInt32(raw, at + 12);
            byte[] image = new byte[length];
            Array.Copy(raw, offset, image, 0, length);
            images.Add(image);
            widths.Add(width);
        }

        // 每组图标要一份“组”资源指向那些 RT_ICON（组号 1 = 资源管理器默认拿它当 exe 图标）
        byte[] group = new byte[6 + 14 * images.Count];
        BitConverter.GetBytes((ushort)0).CopyTo(group, 0);         // reserved
        BitConverter.GetBytes((ushort)1).CopyTo(group, 2);         // type
        BitConverter.GetBytes((ushort)images.Count).CopyTo(group, 4);
        for (int i = 0; i < images.Count; i++)
        {
            int at = 6 + 14 * i;
            int size = widths[i];
            group[at] = (byte)(size >= 256 ? 0 : size);
            group[at + 1] = (byte)(size >= 256 ? 0 : size);
            group[at + 2] = 0;
            group[at + 3] = 0;
            BitConverter.GetBytes((ushort)1).CopyTo(group, at + 4);            // 色面
            BitConverter.GetBytes((ushort)32).CopyTo(group, at + 6);           // 每像素位数
            BitConverter.GetBytes(images[i].Length).CopyTo(group, at + 8);     // 这张多大
            BitConverter.GetBytes((ushort)(i + 1)).CopyTo(group, at + 12);     // 对应 RT_ICON 的编号
        }

        IntPtr update = BeginUpdateResource(exe, false);   // false：保住别的资源（注入进去的 blob 就在那儿）
        if (update == IntPtr.Zero) { throw new InvalidOperationException("打不开这个 exe 的资源表（错误码 " + Marshal.GetLastWin32Error() + "）"); }
        bool done = false;
        try
        {
            for (int i = 0; i < images.Count; i++)
            {
                if (!UpdateResource(update, (IntPtr)RT_ICON, (IntPtr)(i + 1), LANG_NEUTRAL, images[i], (uint)images[i].Length))
                {
                    throw new InvalidOperationException("写第 " + (i + 1) + " 张图失败（错误码 " + Marshal.GetLastWin32Error() + "）");
                }
            }
            if (!UpdateResource(update, (IntPtr)RT_GROUP_ICON, (IntPtr)1, LANG_NEUTRAL, group, (uint)group.Length))
            {
                throw new InvalidOperationException("写图标组失败（错误码 " + Marshal.GetLastWin32Error() + "）");
            }
            done = true;
        }
        finally
        {
            EndUpdateResource(update, !done);   // 出错就丢掉这次的改动
        }
    }
}
