using System.Diagnostics;
using System.IO;
using System.Net.Http;

namespace PiChat;

/// <summary>
/// 后端那一头「由谁来起」：这个程序是唯一入口 —— 后端没在跑就自己拉一个；
/// 已经在跑（上次拉起的、VS Code 起的、终端里起的）就直接接上去。
///
/// 后端从哪儿来，按这个顺序：
///   1. 环境变量 `PICHAT_SERVER`（指到 serverMain.js 也行，调试时方便）；
///   2. 从本程序所在目录往上找 <c>out\server\serverMain.js</c> —— 在仓库里的时候走这条：
///      改完后端只要 `npm run compile`（再重启后端）就生效，不用重新编这个 exe；
///   3. **这个 exe 里嵌着的那一份**（`dotnet build` 时装进去的，见 Payload.cs）——
///      把 exe 拷到别的机器 / 别的目录时走这条，自带后端。
/// 都找不到就报一句人话（界面上写出来），不去猜。
/// </summary>
internal sealed class BackendHost
{
    /// <summary>自己拉起来的那个后端（要自己收摊）；接别人的就是 null。</summary>
    private Process? _owned;

    /// <summary>后端有没有在跑（`/health` 答不答得上来）。</summary>
    public static async Task<bool> HealthyAsync(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
            using var response = await http.GetAsync(url.TrimEnd('/') + "/health");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 保证这个地址上有个后端在跑：在跑就直接返回；没在跑就叫一个起来（最多等 40 秒）。
    /// 叫不起来抛一句人话（界面上直接显示这句）。
    /// </summary>
    /// <param name="progress">给界面上那行状态用的「正在干什么」</param>
    public async Task EnsureAsync(string url, Action<string> progress)
    {
        if (await HealthyAsync(url)) { return; }

        progress("后端没在跑，正在启动后端…");
        var launch = FindServer();
        if (launch is null)
        {
            throw new InvalidOperationException(
                "找不到后端：这个 exe 里没有嵌后端，旁边也没有 out\\server\\serverMain.js。"
                + "在仓库里跑一次 build.bat（它先把后端编好、再嵌进这个 exe），"
                + "或者把环境变量 PICHAT_SERVER 指到 out\\server\\serverMain.js。");
        }

        var port = PortOf(url);
        var dir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var logFile = LogFile;
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(logFile)!);

        var info = new ProcessStartInfo
        {
            FileName = launch.Value.FileName,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = launch.Value.WorkDir,
        };
        foreach (var arg in launch.Value.Args) { info.ArgumentList.Add(arg); }
        foreach (var arg in new[] { "--cwd", dir, "--port", port.ToString() }) { info.ArgumentList.Add(arg); }

        // 后端自己的输出写进日志（界面上看不到控制台）
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;

        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        var log = new StreamWriter(new FileStream(logFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        {
            AutoFlush = true,
        };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) { log.WriteLine(e.Data); } };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) { log.WriteLine(e.Data); } };

        try
        {
            process.Start();
        }
        catch (Exception err)
        {
            log.Dispose();
            throw new InvalidOperationException($"起不来后端（{launch.Value.FileName}）：{err.Message}");
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // 等它把端口听起来（单文件 exe 要先解包，慢一点）
        var deadline = DateTime.UtcNow.AddSeconds(40);
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                log.Dispose();
                throw new InvalidOperationException(
                    $"后端一起来就退了（进程退出码 {process.ExitCode}）。看日志：{logFile}");
            }
            if (await HealthyAsync(url))
            {
                _owned = process;
                log.WriteLine($"[{DateTime.Now:HH:mm:ss}] 后端已经起来：{url}（进程 {process.Id}）");
                log.Dispose();
                return;
            }
            await Task.Delay(400);
        }

        log.Dispose();
        try { if (!process.HasExited) { process.Kill(entireProcessTree: true); } } catch { /* 已经没了 */ }
        throw new InvalidOperationException($"后端 40 秒还没起来，看日志：{logFile}");
    }

    /// <summary>
    /// 收摊：告诉后端「退」（它停网页服务、杀掉会话），自己拉起来的那个再确认它真退了（不退就杀）。
    /// 退出这个程序时调用 —— 跟托盘菜单那个「退出」是一回事。
    /// </summary>
    public async Task ShutdownAsync(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            await http.PostAsync(url.TrimEnd('/') + "/shutdown", content);
        }
        catch
        {
            // 后端没在跑 / 已经断了：不用说什么
        }

        if (_owned is null) { return; }
        var process = _owned;
        _owned = null;
        try
        {
            var deadline = DateTime.UtcNow.AddSeconds(6);
            while (DateTime.UtcNow < deadline)
            {
                if (process.HasExited) { return; }
                await Task.Delay(200);
            }
            if (!process.HasExited) { process.Kill(entireProcessTree: true); }
        }
        catch
        {
            // 已经没了
        }
    }

    /// <summary>后端自己的日志（自己拉起来的那一个的输出都写这儿）。</summary>
    public static string LogFile => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PiChat", "backend.log");

    /// <summary>地址里的端口；没写或者写了个不像样的就按后端出厂那个来。</summary>
    private static int PortOf(string url)
    {
        try
        {
            var parsed = new Uri(url.TrimEnd('/') + "/");
            if (parsed.Port > 0) { return parsed.Port; }
        }
        catch { /* 落下去用默认的 */ }
        return 51883;
    }

    /// <summary>去哪里找后端：环境变量 → 这个 exe 里嵌着的 → 仓库里那套（都用本机的 node 跑）。</summary>
    private static (string FileName, string[] Args, string WorkDir) ? FindServer()
    {
        var fromEnv = Environment.GetEnvironmentVariable("PICHAT_SERVER");
        if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(fromEnv))
        {
            return ("node", new[] { fromEnv }, System.IO.Path.GetDirectoryName(fromEnv)!);
        }

        // 在仓库里：用仓库里刚编出来的那份（改完代码不用重新编 exe）
        for (var dir = AppDirectory(); dir is not null; dir = System.IO.Path.GetDirectoryName(dir))
        {
            var script = System.IO.Path.Combine(dir, "out", "server", "serverMain.js");
            if (File.Exists(script)) { return ("node", new[] { script }, dir); }
        }

        // 不在仓库里（exe 被拷到别处）：用嵌在这个 exe 里的那份
        if (Payload.Present)
        {
            try
            {
                var bundle = Payload.Unpack();
                return ("node", new[] { bundle }, System.IO.Path.GetDirectoryName(bundle)!);
            }
            catch (Exception err)
            {
                AppLog.Write("内嵌的后端解不出来：" + err.Message);
            }
        }
        return null;
    }

    /// <summary>本程序在哪个目录（探仓库时从它往上找）。</summary>
    private static string AppDirectory()
    {
        var exe = Environment.ProcessPath;
        if (!string.IsNullOrEmpty(exe)) { return System.IO.Path.GetDirectoryName(exe)!; }
        return AppContext.BaseDirectory;
    }
}
