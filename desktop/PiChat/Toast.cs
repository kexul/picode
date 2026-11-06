using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace PiChat;

/// <summary>
/// 屏幕右下角那张「有事」的提醒卡片（跑完一轮 / 在等你答一句时冒出来）。
///
/// 跟以前那支托盘小程序弹的那张一回事：一块小白卡片，写哪个会话、说了什么，最多三张叠着，
/// 停半分钟自己收走，鼠标移上去就停住，点一下开主界面并切到那个会话。
/// 只是现在由这个小窗口自己画（它本来就连着后端那条 /phone，知道每一条是什么）。
/// </summary>
internal static class Toast
{
    /// <summary>一张卡最多停多久（鼠标停在上面就不算）。</summary>
    private static readonly TimeSpan Life = TimeSpan.FromSeconds(30);
    private const int MaxCards = 3;
    private const double Gap = 8;

    private static readonly List<ToastWindow> Shown = new();

    /// <summary>弹一张。同样标识的卡片只换不堆（后来那条顶掉旧的）。</summary>
    /// <param name="onClick">点了这一张</param>
    public static void Show(string key, string title, string body, bool ask, Action onClick)
    {
        // 同一个会话反复推过来：把旧的换掉（位置也接着上一个，别跳）
        var index = Shown.FindIndex(item => item.Key == key);
        double? keepTop = null;
        if (index >= 0)
        {
            keepTop = Shown[index].Top;
            Shown[index].CloseNow();
            Shown.RemoveAt(index);
        }
        if (Shown.Count >= MaxCards)
        {
            Shown[0].CloseNow();
            Shown.RemoveAt(0);
        }

        var window = new ToastWindow(key, title, body, ask, onClick);
        Shown.Add(window);
        window.Show();
        // 排位置要等它量完自己多大（刚 Show 出来那一刻 ActualHeight 还是 0）
        var top = keepTop;
        window.Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Loaded,
            new Action(() => Arrange(top)));
        Chime.Play(ask);

        var timer = new DispatcherTimer { Interval = Life };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (window.Hovered) { timer.Start(); return; }
            CloseFor(window);
        };
        window.Timer = timer;
        timer.Start();
    }

    /// <summary>某一张自己关掉了（点过、或者到点了）：把它从名单里摘掉，剩下的重新排一下。</summary>
    private static void CloseFor(ToastWindow window)
    {
        window.Timer?.Stop();
        if (!Shown.Remove(window)) { return; }
        window.CloseNow();
        Arrange(null);
    }

    /// <summary>从下往上排：最先弹的那张在最下面。</summary>
    /// <param name="keepTop">换掉旧卡片时，新的先站它原来的位置（不然会跳一下）</param>
    private static void Arrange(double? keepTop)
    {
        var area = WorkArea();
        var bottom = area.Bottom - 12;
        for (var i = Shown.Count - 1; i >= 0; i--)
        {
            var window = Shown[i];
            if (window == null) { continue; }
            if (keepTop != null && window.Top != keepTop)
            {
                window.Top = keepTop.Value;
                keepTop = null;
                bottom = window.Top - Gap;
                continue;
            }
            window.Top = bottom - window.ActualHeight;
            bottom = window.Top - Gap;
        }
    }

    /// <summary>屏幕右下角那块地方（扣掉任务栏）。</summary>
    private static Rect WorkArea()
    {
        var screen = SystemParameters.WorkArea;
        return new Rect(screen.Left, screen.Top, screen.Width, screen.Height);
    }

    internal static void ForgetAll()
    {
        foreach (var window in Shown.ToArray()) { window.CloseNow(); }
        Shown.Clear();
    }

    /// <summary>一张卡片：浅色圆角，边上一条竖线（等你答是黄的，跑完是绿的）。</summary>
    private sealed class ToastWindow : Window
    {
        public string Key { get; }
        public DispatcherTimer? Timer { get; set; }
        public bool Hovered { get; private set; }

        public ToastWindow(string key, string title, string body, bool ask, Action onClick)
        {
            Key = key;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = true;
            SizeToContent = SizeToContent.Height;
            Width = 340;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Focusable = false;

            var accent = ask ? Color.FromRgb(0xB2, 0x6A, 0x00) : Color.FromRgb(0x2E, 0x7D, 0x32);
            var line = new Border
            {
                Width = 3,
                Background = new SolidColorBrush(accent),
                CornerRadius = new CornerRadius(2, 0, 0, 2),
            };
            var text = new StackPanel { Margin = new Thickness(10, 9, 12, 9) };
            text.Children.Add(new TextBlock
            {
                Text = title,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Color.FromRgb(0x11, 0x18, 0x27)),
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            text.Children.Add(new TextBlock
            {
                Text = body,
                FontSize = 12,
                Foreground = new SolidColorBrush(Color.FromRgb(0x4B, 0x55, 0x63)),
                TextWrapping = TextWrapping.Wrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxHeight = 46,
                Margin = new Thickness(0, 4, 0, 0),
            });

            var inner = new StackPanel { Orientation = Orientation.Horizontal };
            inner.Children.Add(line);
            inner.Children.Add(text);

            Content = new Border
            {
                Background = new SolidColorBrush(Color.FromRgb(0xFF, 0xFF, 0xFF)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(0xD8, 0xDB, 0xE0)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Child = inner,
                Effect = new System.Windows.Media.Effects.DropShadowEffect
                {
                    BlurRadius = 14,
                    ShadowDepth = 2,
                    Opacity = 0.18,
                    Color = Colors.Black,
                },
            };

            MouseEnter += (_, _) => Hovered = true;
            MouseLeave += (_, _) => Hovered = false;
            MouseLeftButtonUp += (_, _) =>
            {
                onClick();
                Toast.CloseFor(this);
            };

            Loaded += (_, _) =>
            {
                // 从右边滑进来一点，别硬生生出现
                Left = WorkArea().Right - Width - 12;
                BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160)));
            };
        }

        /// <summary>不带动画地消失（换卡片、清理时用）。</summary>
        public void CloseNow()
        {
            try
            {
                ClearValue(OpacityProperty);
                Close();
            }
            catch { /* 已经关了 */ }
        }
    }
}

/// <summary>
/// 响一声：跑完一轮是往上两个音，等你答一句是同一高度敲三下（跟以前那支小程序一样）。
/// 自己算波形放着，不跟 Windows 的声音方案走（那里把「通知」设成无声也照样响），整机静音当然还是不响。
/// </summary>
internal static class Chime
{
    private const int Rate = 44100;
    private static SoundPlayer? _done;
    private static SoundPlayer? _ask;

    public static void Play(bool ask)
    {
        try
        {
            var player = ask ? (_ask ??= Build(true)) : (_done ??= Build(false));
            // Play 自己开一个线程放，不挡界面；放不出来（没声卡之类）就算了
            player.Play();
        }
        catch { /* 放不出来不影响弹卡片 */ }
    }

    private static SoundPlayer Build(bool ask)
    {
        return new SoundPlayer(new MemoryStream(Rendered(ask)));
    }

    /// <summary>两段音的波形（16 位 PCM 单声道，套上 wav 头）。</summary>
    private static byte[] Rendered(bool ask)
    {
        // 一段音 = 频率(Hz) + 多长(毫秒)；音和音之间空 40 毫秒
        var steps = ask
            ? new[] { new[] { 1047, 80 }, new[] { 1047, 80 }, new[] { 1047, 80 } }
            : new[] { new[] { 880, 130 }, new[] { 1175, 190 } };
        var gapSamples = Rate * 40 / 1000;
        var frames = gapSamples * (steps.Length - 1);
        foreach (var step in steps) { frames += Rate * step[1] / 1000; }

        var pcm = new byte[frames * 2];
        var at = 0;
        for (var i = 0; i < steps.Length; i++)
        {
            var freq = steps[i][0];
            var tone = Rate * steps[i][1] / 1000;
            for (var n = 0; n < tone; n++)
            {
                // 起手 10 毫秒淡入、最后 40 毫秒淡出
                var env = Math.Min(Math.Min(1.0, n / (Rate * 0.01)), (tone - n) / (Rate * 0.04));
                var phase = 2 * Math.PI * freq * n / Rate;
                var v = (Math.Sin(phase) + 0.25 * Math.Sin(2 * phase)) / 1.25 * env * 0.28;
                var s = (short)Math.Round(v * short.MaxValue);
                pcm[at++] = (byte)(s & 0xFF);
                pcm[at++] = (byte)((s >> 8) & 0xFF);
            }
            if (i < steps.Length - 1) { at += gapSamples * 2; }
        }
        return WavOf(pcm);
    }

    /// <summary>给一段 16 位 PCM 套上 44 字节的 wav 头。</summary>
    private static byte[] WavOf(byte[] pcm)
    {
        var stream = new MemoryStream();
        var w = new BinaryWriter(stream);
        w.Write(Encoding.ASCII.GetBytes("RIFF"));
        w.Write(36 + pcm.Length);
        w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        w.Write(16);        // fmt 块长度
        w.Write((short)1);  // PCM
        w.Write((short)1);  // 单声道
        w.Write(Rate);
        w.Write(Rate * 2);  // 每秒字节数
        w.Write((short)2);  // 每帧字节数
        w.Write((short)16); // 位深
        w.Write(Encoding.ASCII.GetBytes("data"));
        w.Write(pcm.Length);
        w.Write(pcm);
        w.Flush();
        return stream.ToArray();
    }
}
