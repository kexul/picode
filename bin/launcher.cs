/*
 * pichat 的壳（单文件 exe 的本体，`-target:winexe`，所以双击没有黑框）。
 *
 * 干什么：把打包时塞进资源里的那几样东西（JS bundle、界面文件、托盘与截屏两支小程序）
 * 解到缓存目录，找到这台机器上的 Node，然后跑起来。
 *
 * 为什么这么做：Node 单文件应用（SEA）要把一整个 node.exe 当底座，产物 90MB 里有 88MB 是
 * 运行时。既然这台机器本来就有 Node，那就只带自己的东西（约 2.5MB），跑的时候借本机的 Node。
 *
 * 解出来的目录是「仓库那套结构」：
 *   <缓存>\app-<版本>\out\server\bundle.cjs     ← 我们的后端（一个文件）
 *   <缓存>\app-<版本>\media\…                   ← 界面文件
 *   <缓存>\app-<版本>\bin\tray.exe / shot.exe   ← 两支小程序
 * 这样后端里那套 `__dirname/../..` 的路径代码一行都不用改。
 *
 * 编法见 scripts/build-exe.mjs（系统自带的 csc.exe）：
 *   -resource:payload.txt,payload   ← 一行一个文件：「编号<TAB>相对路径」
 *   -resource:p0,编号 0 那个文件 …  ← 顺序与 payload.txt 一致
 *   -resource:version.txt,version
 *   -win32icon:pichat.ico           ← exe 的文件图标
 */
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

static class Launcher
{
    private const string AppName = "PiChat";
    /** 后端要的 Node 版本（见 README 的「环境要求」）。 */
    private const int MinNodeMajor = 20;

    [STAThread]
    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception err)
        {
            DumpError(err);
            Complain(err.Message);
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        string version = ReadText("version.txt").Trim();
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
        string appDir = Path.Combine(dataDir, "app-" + (version.Length > 0 ? version : "dev"));
        Unpack(appDir);

        string node = FindNode();
        if (node == null)
        {
            Complain("找不到 Node.js（要求 " + MinNodeMajor + " 或以上）。\n\n"
                + "装一个就行：https://nodejs.org/\n"
                + "装在别处的话，设一个环境变量 PICHAT_NODE 指向 node.exe 再双击我。");
            return 1;
        }
        int major = NodeMajor(node);
        if (major > 0 && major < MinNodeMajor)
        {
            Complain("这台机器的 Node 是 " + major + "，要求 " + MinNodeMajor + " 或以上。\n\n"
                + "升级一下：" + node);
            return 1;
        }

        // 双击（没有参数）时按“传统 app”那套来：会话开在家目录，起来就把界面打开。
        // 带了参数就照原样交给后端（--cwd / --port / --host / --open 都认）。
        string[] childArgs;
        if (args.Length == 0)
        {
            childArgs = new[]
            {
                Path.Combine(appDir, "out", "server", "bundle.cjs"),
                "--cwd", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "--open",
            };
        }
        else
        {
            childArgs = new string[args.Length + 1];
            childArgs[0] = Path.Combine(appDir, "out", "server", "bundle.cjs");
            Array.Copy(args, 0, childArgs, 1, args.Length);
        }

        return RunNode(node, childArgs, Path.Combine(dataDir, "pichat.log"));
    }

    /** 起 Node 跑后端，把它的输出写进日志文件（GUI 没有控制台），等它退出。 */
    private static int RunNode(string node, string[] childArgs, string logFile)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(logFile) ?? ".");
        // 日志太长就先清一次：这是给人翻问题用的，不是账本
        try { if (new FileInfo(logFile).Length > 4L * 1024 * 1024) { File.Delete(logFile); } } catch { /* 清不掉就接着写 */ }

        ProcessStartInfo info = new ProcessStartInfo(node);
        info.Arguments = JoinArguments(childArgs);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        // Node 写出来的是 UTF-8，而 .NET Framework 默认按控制台代码页（中文机器上是 GBK）解，
        // 不指明的话日志里全是乱码
        info.StandardOutputEncoding = new UTF8Encoding(false);
        info.StandardErrorEncoding = new UTF8Encoding(false);
        info.WorkingDirectory = Path.GetDirectoryName(childArgs[0]) ?? ".";
        info.EnvironmentVariables["PICHAT_LAUNCHER"] = Application.ExecutablePath;

        using (Process child = new Process())
        {
            child.StartInfo = info;
            child.OutputDataReceived += (s, e) => Write(logFile, e.Data);
            child.ErrorDataReceived += (s, e) => Write(logFile, e.Data);
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    /** 追加一行到日志（多线程一起写，加个锁）。 */
    private static readonly object LogLock = new object();

    private static void Write(string file, string text)
    {
        if (text == null) { return; }
        lock (LogLock)
        {
            try
            {
                using (StreamWriter writer = new StreamWriter(file, true, new UTF8Encoding(false)))
                {
                    writer.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " " + text);
                }
            }
            catch { /* 写不进去也不能把后端带崩 */ }
        }
    }

    // ---- 解包 ----

    /** 缓存目录里还没有这一版就解一份出来（有 .ready 就直接用）。 */
    private static void Unpack(string appDir)
    {
        string ready = Path.Combine(appDir, ".ready");
        if (File.Exists(ready)) { return; }
        Directory.CreateDirectory(appDir);
        Assembly asm = Assembly.GetExecutingAssembly();
        foreach (string line in ReadText("payload.txt").Split('\n'))
        {
            string item = line.Trim();
            if (item.Length == 0) { continue; }
            int tab = item.IndexOf('\t');
            if (tab <= 0) { continue; }
            string resource = item.Substring(0, tab);
            string relative = item.Substring(tab + 1).Replace('/', Path.DirectorySeparatorChar);
            string target = Path.Combine(appDir, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target) ?? appDir);
            using (Stream input = asm.GetManifestResourceStream(resource))
            {
                if (input == null) { throw new InvalidOperationException("打包里少了：" + resource); }
                using (FileStream output = File.Create(target)) { input.CopyTo(output); }
            }
        }
        File.WriteAllText(ready, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
    }

    private static string ReadText(string resource)
    {
        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream stream = asm.GetManifestResourceStream(resource))
        {
            if (stream == null) { throw new InvalidOperationException("打包里少了：" + resource); }
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }
    }

    // ---- 找 Node ----

    private static string FindNode()
    {
        string fromEnv = Environment.GetEnvironmentVariable("PICHAT_NODE");
        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) { return fromEnv; }

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string piece in path.Split(';'))
        {
            string dir = piece.Trim();
            if (dir.Length == 0) { continue; }
            try
            {
                string candidate = Path.Combine(dir, "node.exe");
                if (File.Exists(candidate)) { return candidate; }
            }
            catch { /* 路径里有非法字符，跳过 */ }
        }

        string[] known =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        foreach (string candidate in known) { if (File.Exists(candidate)) { return candidate; } }
        return null;
    }

    /** 问一下 node.exe 是几版（拿不到就返回 0，当“不知道”）。 */
    private static int NodeMajor(string node)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(node);
            info.Arguments = "--version";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (Process probe = Process.Start(info))
            {
                string text = probe.StandardOutput.ReadToEnd().Trim();
                probe.WaitForExit(5000);
                // "v24.16.0" 这样
                if (text.StartsWith("v")) { text = text.Substring(1); }
                int dot = text.IndexOf('.');
                int major;
                if (dot > 0 && int.TryParse(text.Substring(0, dot), out major)) { return major; }
            }
        }
        catch { /* 问不出来就说不知道 */ }
        return 0;
    }

    /**
     * 把参数拼成一行命令行。
     * 为什么不用 ProcessStartInfo.ArgumentList：那是 .NET Core 以后才有的，
     * 我们编壳用的是 .NET Framework 那套 csc（系统自带，不用装东西）。
     */
    private static string JoinArguments(string[] args)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string arg in args)
        {
            if (sb.Length > 0) { sb.Append(' '); }
            bool needQuote = arg.Length == 0;
            foreach (char c in arg) { if (c == ' ' || c == '\t' || c == '"') { needQuote = true; break; } }
            if (!needQuote) { sb.Append(arg); continue; }
            sb.Append('"');
            foreach (char c in arg)
            {
                if (c == '"') { sb.Append('\\'); }
                sb.Append(c);
            }
            sb.Append('"');
        }
        return sb.ToString();
    }

    /** 把出错时的完整堆栈写一份到临时目录：弹框只看得见第一句，查问题要细节。 */
    private static void DumpError(Exception err)
    {
        try
        {
            File.WriteAllText(Path.Combine(Path.GetTempPath(), "pichat-launcher-error.txt"), err.ToString(), Encoding.UTF8);
        }
        catch { /* 连这个都写不了就算了 */ }
    }

    /** 出岔子时弹一个框（GUI 没有控制台，光打日志没人看得见）。 */
    private static void Complain(string text)
    {
        try
        {
            MessageBox.Show(text, "Pi Chat", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch { /* 连框都弹不出来就算了 */ }
    }
}
