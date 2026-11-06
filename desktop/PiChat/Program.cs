using System.IO;
using System.IO.Pipes;
using System.Threading;
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

        // 只允许跑一个：后端每次起来都会叫一次这个程序，人也会双击它 —— 都该落到同一个身上
        // （第二个只负责把第一个叫出来，然后自己退）。
        using var single = new Mutex(true, "PiChat.App.SingleInstance", out var first);
        if (!first)
        {
            // 命令带上这次的地址：后端换了端口重启时，正在跑的那个要跟着换过去
            SignalRunning((options.Hidden ? "hidden" : "show") + "|" + (options.Url ?? ""));
            return;
        }

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.DispatcherUnhandledException += (_, e) =>
        {
            AppLog.Write("出错了：" + e.Exception);
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => AppLog.Write("崩了：" + e.ExceptionObject);
        var window = new MainWindow(options, app);
        ListenForOtherInstances(window);
        // 后端拉起时给的是 --hidden：只出托盘图标，不弹窗口（左键点图标才开）
        if (!options.Hidden) { window.ShowMain(); }
        app.Run();
        window.DisposeUi();
    }

    /// <summary>告诉已经在跑的那个「有人找你」：show = 开主界面，hidden = 只是被后端叫了一次。</summary>
    private static void SignalRunning(string command)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            pipe.Connect(800);
            using var writer = new StreamWriter(pipe);
            writer.WriteLine(command);
            writer.Flush();
        }
        catch
        {
            // 叫不动就算了：多半是它正在退
        }
    }

    private const string PipeName = "PiChat.App.Show";

    /// <summary>后面再有人叫这个程序（双击、后端拉起、托盘那条 --session）：在这里接。</summary>
    private static void ListenForOtherInstances(MainWindow window)
    {
        var thread = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.In);
                    pipe.WaitForConnection();
                    using var reader = new StreamReader(pipe);
                    var line = reader.ReadLine()?.Trim() ?? "";
                    var split = line.IndexOf('|');
                    var command = split >= 0 ? line[..split] : line;
                    var url = split >= 0 ? line[(split + 1)..].Trim() : "";
                    if (url.Length > 0) { window.UseBackendUrl(url); }
                    if (command == "show") { window.ShowMain(); }
                }
                catch (Exception err)
                {
                    // 叫不出来就记一笔，接着听下一个（管道这一条断了不代表以后都用不着）
                    AppLog.Write("别的程序叫我来着，没叫出来：" + err);
                    Thread.Sleep(200);
                }
            }
        })
        {
            IsBackground = true,
            Name = "pi-chat-instance",
        };
        thread.Start();
    }
}

/// <summary>
/// 命令行参数：
///   --session &lt;会话标识&gt;  启动时直接选中这个会话
///   --url &lt;后端地址&gt;       这次用这个地址，并记下来
///   --hidden                起来只待在托盘里，不弹窗口（后端叫它起来时就用这个）
/// </summary>
internal sealed class StartupOptions
{
    public string? SessionId { get; private set; }
    public string? Url { get; private set; }
    public bool Hidden { get; private set; }

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
                case "--hidden":
                    options.Hidden = true;
                    break;
            }
        }
        return options;
    }
}
