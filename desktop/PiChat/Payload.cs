using System.IO;
using System.Reflection;

namespace PiChat;

/// <summary>
/// 编进 exe 里的那一份后端（见 scripts/build-payload.mjs）：bundle + 界面文件 + 两支小程序。
///
/// 这个程序只有一个文件，后端也在里头。第一次用到时把内嵌的那些解到
/// `%LOCALAPPDATA%\PiChat\app-&lt;版本&gt;-&lt;指纹&gt;\`（指纹变了才重新解：改了代码重编一次就换目录），
/// 然后用这台机器上装的 Node 跑里面的 `out/server/bundle.cjs`。
///
/// 不带 Node 运行时（那要多几十 MB）：跟以前那个单文件后端一样，要求机器上装了 Node 20 或以上。
/// </summary>
internal static class Payload
{
    /// <summary>有没有把后端嵌进来（用 dotnet build 编的时候会自动塞；没塞的话退回仓库里那套）。</summary>
    public static bool Present => Names().Count > 0;

    /// <summary>
    /// 把后端解出来（已经解过就直接用），返回 `out/server/bundle.cjs` 的完整路径。
    /// </summary>
    public static string Unpack()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var names = Names();
        if (names.Count == 0) { throw new InvalidOperationException("这个 exe 里没有内嵌后端。"); }

        var version = assembly.GetName().Version?.ToString() ?? "1.0.0";
        var dir = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PiChat", "app-" + Fingerprint(names));

        var entry = System.IO.Path.Combine(dir, "out", "server", "bundle.cjs");
        if (!File.Exists(entry))
        {
            // 先解到旁边一个临时目录再整个换过去：解一半被打断也不会留下一个“看着像好了”的目录
            var staging = dir + "-new";
            try { if (Directory.Exists(staging)) { Directory.Delete(staging, true); } } catch { /* 上次留下的 */ }
            Directory.CreateDirectory(staging);
            foreach (var name in names)
            {
                using var stream = assembly.GetManifestResourceStream(name);
                if (stream is null) { continue; }
                var relative = RelativeOf(name);
                var target = System.IO.Path.Combine(staging, relative);
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
                using var file = File.Create(target);
                stream.CopyTo(file);
            }
            try { if (Directory.Exists(dir)) { Directory.Delete(dir, true); } } catch { /* 正被上一次的后端占着 */ }
            if (!Directory.Exists(dir)) { Directory.Move(staging, dir); }
            _ = version;
        }
        if (!File.Exists(entry))
        {
            throw new InvalidOperationException("内嵌的后端解包失败：" + entry);
        }
        return entry;
    }

    /// <summary>内嵌资源的名字（只认 payload/ 开头那些）。</summary>
    private static List<string> Names()
    {
        var assembly = Assembly.GetExecutingAssembly();
        return assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith("payload/", StringComparison.Ordinal))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>`payload/media/chat.css` → `media/chat.css`。</summary>
    private static string RelativeOf(string resourceName)
    {
        var relative = resourceName["payload/".Length..];
        return relative.Replace('\\', System.IO.Path.DirectorySeparatorChar);
    }

    /// <summary>内容指纹（资源名 + 大小拼出来的短哈希）：改了代码就换一个解包目录。</summary>
    private static string Fingerprint(List<string> names)
    {
        var assembly = Assembly.GetExecutingAssembly();
        long total = 0;
        foreach (var name in names)
        {
            using var stream = assembly.GetManifestResourceStream(name);
            total = (total * 31 + (stream?.Length ?? 0)) % 1000000007;
        }
        var sum = 0;
        foreach (var name in names) { sum = (sum * 7 + name.GetHashCode(StringComparison.Ordinal)) & 0x7FFFFFFF; }
        return $"{total:x}{sum:x}";
    }
}
