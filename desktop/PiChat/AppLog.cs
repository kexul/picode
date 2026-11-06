using System.IO;

namespace PiChat;

/// <summary>
/// 出岔子记一笔（`%APPDATA%\PiChat\app.log`）。
///
/// 这个小窗口是个没有黑框的程序：它崩了、或者某个动作没做成，界面上什么都不会说，
/// 人只看到「点了没反应」。所以攒下来的那几行是唯一能查的东西（托盘叫不出来、
/// 退出时后端不理、启动就崩，都写在这儿）。
/// </summary>
internal static class AppLog
{
    private static readonly object Gate = new();

    public static string FilePath => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PiChat", "app.log");

    public static void Write(string text)
    {
        try
        {
            lock (Gate)
            {
                var file = FilePath;
                var dir = System.IO.Path.GetDirectoryName(file);
                if (!string.IsNullOrEmpty(dir)) { Directory.CreateDirectory(dir); }
                // 太长就从头再来（这是个记事本，不是账本）
                var info = new FileInfo(file);
                if (info.Exists && info.Length > 256 * 1024) { File.Delete(file); }
                File.AppendAllText(file, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {text}{Environment.NewLine}");
            }
        }
        catch
        {
            // 写不进去就算了：日志写不出来不该再带崩一件事
        }
    }
}
