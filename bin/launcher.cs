/*
 * PiChat 的壳（单文件 exe 的本体，`-target:winexe`，所以双击没有黑框）。
 *
 * 干什么：把打包时塞进资源里的那几样东西（JS bundle、界面文件、那几支小程序）解到缓存目录，
 * 找到这台机器上的 Node，然后跑起来；后端退出它跟着退。
 *
 * 为什么这么做：Node 单文件应用（SEA）要把一整个 node.exe 当底座，产物 90MB 里有 88MB 是
 * 运行时。既然这台机器本来就有 Node，那就只带自己的东西（几 MB），跑的时候借本机的 Node。
 *
 * 解出来的目录是「仓库那套结构」（目录名用的是这一版的内容指纹，重新打包就换一个目录）：
 *   <缓存>\app-<指纹>\out\server\bundle.cjs     ← 我们的后端（一个文件）
 *   <缓存>\app-<指纹>\media\…                   ← 界面文件
 *   <缓存>\app-<指纹>\bin\*.exe                 ← 托盘 / 截图 / 实时画面 / 提醒卡片
 * 这样后端里那套 `__dirname/../..` 的路径代码一行都不用改。
 *
 * 托盘不在这里：后端起来以后自己拉起 bin\tray.exe（终端里起的 pichat 也一样有），
 * 所以这个壳只干「解包 + 找 Node + 起后端 + 等它退」。
 *
 * 编法见 scripts/build-exe.mjs（系统自带的 csc.exe）：
 *   -resource:payload.txt,payload   ← 一行一个文件：「编号<TAB>相对路径」
 *   -resource:p0,编号 0 那个文件 …  ← 顺序与 payload.txt 一致
 *   -resource:fingerprint.txt,fingerprint
 *   -win32icon:PiChat.ico           ← exe 的文件图标
 */
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

static class Launcher
{
    private const string AppName = "PiChat";
    /** 后端要的 Node 版本。 */
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
        string fingerprint = ReadText("fingerprint.txt").Trim();
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
        string appDir = Path.Combine(dataDir, "app-" + (fingerprint.Length > 0 ? fingerprint : "dev"));
        Unpack(appDir);
        RemoveOldAppDirs(dataDir, appDir);

        // 已经有一个后端在跑（终端里起的、或者另一个 exe）：只把那个页面打开，不起第二个
        string running = RunningServerUrl();
        if (running != null)
        {
            OpenUrl(running);
            return 0;
        }

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
        // 带了参数就照原样交给后端（--cwd / --port / --host / --open 都认；
        // 「编译并重启」起回来时会带上 --no-open，那时页面自己会连回来）。
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

        DateTime started = DateTime.UtcNow;
        int code = RunNode(node, childArgs, Path.Combine(dataDir, "pichat.log"));

        // 后端刚起来就退了、而其实另一个后端在跑（探活那一下没赶上）：把那个页面打开。
        if (code != 0 && (DateTime.UtcNow - started).TotalSeconds < 5)
        {
            string other = RunningServerUrl();
            if (other != null) { OpenUrl(other); }
        }
        return code;
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
        // 后端要能认出“我是 exe 起的”（决定「编译并重启」怎么走，见 src/serverRestart.ts），
        // 也要知道是哪个 exe（它会等这个进程退掉才重新打包）
        info.EnvironmentVariables["PICHAT_LAUNCHER"] = Application.ExecutablePath;
        // Node 写出来的是 UTF-8，而 .NET Framework 默认按控制台代码页（中文机器上是 GBK）解，
        // 不指明的话日志里全是乱码
        info.StandardOutputEncoding = new UTF8Encoding(false);
        info.StandardErrorEncoding = new UTF8Encoding(false);
        info.WorkingDirectory = Path.GetDirectoryName(childArgs[0]) ?? ".";
        // 托盘小程序要从后端手里拿管道：后端自己起它，这里不必管

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

    /** 以前那几版解出来的目录顺手删掉（正被别人占着就删不动，那就算了）。 */
    private static void RemoveOldAppDirs(string dataDir, string current)
    {
        try
        {
            foreach (string dir in Directory.GetDirectories(dataDir, "app-*"))
            {
                if (string.Equals(Path.GetFullPath(dir), Path.GetFullPath(current), StringComparison.OrdinalIgnoreCase)) { continue; }
                try { Directory.Delete(dir, true); } catch { /* 还在用 / 删不动，留着 */ }
            }
        }
        catch { /* 缓存目录都列不出来就算了 */ }
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

    // ---- 已经在跑的后端 ----

    /** 后端地址文件放哪儿（跟 src/serverPaths.ts 一个规矩：PICHAT_HOME 能整个换掉）。 */
    private static string PichatDir()
    {
        string home = Environment.GetEnvironmentVariable("PICHAT_HOME");
        if (!string.IsNullOrEmpty(home)) { return home; }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pi", "pichat");
    }

    /** 地址文件里那个地址；没有 / 坏 JSON / 探不通都当没有。 */
    private static string RunningServerUrl()
    {
        try
        {
            string file = Path.Combine(PichatDir(), "server.json");
            if (!File.Exists(file)) { return null; }
            string text = File.ReadAllText(file, Encoding.UTF8);
            Match match = Regex.Match(text, "\"url\"\\s*:\\s*\"([^\"]+)\"");
            if (!match.Success) { return null; }
            string url = match.Groups[1].Value.Replace("\\/", "/");
            if (!url.EndsWith("/")) { url += "/"; }
            return Healthy(url + "health") ? url : null;
        }
        catch { return null; }
    }

    /** 探一下那个地址上是不是我们的后端（跟 Node 那边 findRunningServer 一个意思）。 */
    private static bool Healthy(string url)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Timeout = 1500;
            request.ReadWriteTimeout = 1500;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                return (int)response.StatusCode == 200;
            }
        }
        catch { return false; }
    }

    /** 用系统默认浏览器打开这个地址（打不开就算了：不是非做不可的事）。 */
    private static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { /* 打不开算了 */ }
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
