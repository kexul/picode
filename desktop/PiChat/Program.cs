using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace PiChat;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // 远程桌面、虚拟机这类机器上，WPF 走显卡渲染有时整块窗口只剩一片白；
        // 这里界面很小，直接走软件渲染，换来哪儿都能画出来。
        RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;

        var options = StartupOptions.Parse(args);
        var app = new Application();
        app.Run(new MainWindow(options));
    }
}

/// <summary>
/// 命令行参数：
///   --session &lt;会话标识&gt;  启动时直接选中这个会话
///   --url &lt;后端地址&gt;       这次用这个地址，并记下来
/// </summary>
internal sealed class StartupOptions
{
    public string? SessionId { get; private set; }
    public string? Url { get; private set; }

    public static StartupOptions Parse(string[] args)
    {
        var options = new StartupOptions();
        for (var i = 0; i < args.Length; i++)
        {
            var key = args[i];
            string? value = null;

            // --url=http://... 这种带等号的写法也认
            var equals = key.IndexOf('=');
            if (key.StartsWith("--", StringComparison.Ordinal) && equals > 2)
            {
                value = key[(equals + 1)..];
                key = key[..equals];
            }

            switch (key)
            {
                case "--session":
                    if (value == null && i + 1 < args.Length) { value = args[++i]; }
                    options.SessionId = value?.Trim();
                    break;
                case "--url":
                    if (value == null && i + 1 < args.Length) { value = args[++i]; }
                    options.Url = value?.Trim();
                    break;
            }
        }
        return options;
    }
}
