using System.IO;
using System.Text.Json;
using IOPath = System.IO.Path;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace PiChat;

/// <summary>左边一排会话，右边是这个会话里那些「有事」，底下能回一句。</summary>
internal sealed class MainWindow : Window
{
    private readonly Config _config;
    private readonly Backend _backend;
    private readonly Dictionary<string, SessionState> _sessions = new();
    /// <summary>答过的题：卡片编号 → 答的是什么。用来把答过的卡片置灰。</summary>
    private readonly Dictionary<string, string> _answers = new();
    private string? _selectedId;
    private string? _pendingSelect;

    private TextBlock _statusText = null!;
    /** 设置那个小窗口开着时，它里面那行状态（关了就是 null）。 */
    private TextBlock? _dialogStatus;
    private TextBlock _placeholder = null!;
    private StackPanel _sessionList = null!;
    private StackPanel _messages = null!;
    private ScrollViewer _messageScroll = null!;
    private TextBox _inputBox = null!;
    private Button _sendButton = null!;
    private TextBlock _hintText = null!;

    private static readonly Brush Ink = B("#111827");
    private static readonly Brush Gray = B("#6b7280");
    private static readonly Brush Line = B("#e5e7eb");
    private static readonly Brush LightGray = B("#f3f4f6");
    private static readonly Brush Green = B("#166534");
    private static readonly Brush Orange = B("#b45309");
    private static readonly Brush OrangeBg = B("#fef3c7");
    private static readonly Brush Blue = B("#2563eb");
    private static readonly Brush Mine = B("#d9fdd3");
    private static readonly Brush AskBg = B("#fffbeb");
    private static readonly Brush Selected = B("#e8f0fe");
    private static readonly Brush White = Brushes.White;

    private static Brush B(string hex) => (Brush)new BrushConverter().ConvertFromString(hex)!;

    private sealed class SessionState
    {
        public SessionInfo Info = new();
        public List<Note> Notes = new();
    }

    private readonly Application _app;
    private readonly BackendHost _host = new();
    /// <summary>「这一轮」那张卡片的刷新定时器（4 秒一次，看着窗口的时候才刷）。</summary>
    private readonly DispatcherTimer _liveTimer = new() { Interval = TimeSpan.FromSeconds(4) };
    /// <summary>这个会话最近一条回复的原话（「这一轮」那张卡片用；跑着的时候后端会一直变）。</summary>
    private LastReplyPayload? _lastReply;
    private readonly TrayUi _tray;
    /** 真退（菜单里点了退出 / 程序要收摊）：不是退到托盘去。 */
    private bool _quitting;

    public MainWindow(StartupOptions options, Application app)
    {
        _app = app;
        _config = Config.Load();
        if (!string.IsNullOrWhiteSpace(options.Url))
        {
            _config.Url = Backend.Normalize(options.Url);
            Config.Save(_config);
        }
        if (!Backend.IsValid(_config.Url)) { _config.Url = "http://127.0.0.1:51883"; }
        _pendingSelect = options.SessionId;

        BuildUi();
        RestoreWindowBounds();

        _backend = new Backend(_config.Url, Dispatcher);
        _backend.StatusChanged += OnStatus;
        _backend.SessionsArrived += OnSessions;
        _backend.NoteArrived += OnNote;
        _backend.AskDone += OnAskDone;
        _backend.Ended += OnEnded;
        _backend.Start();

        // 这个程序是入口：后端没在跑就自己拉一个起来（双击它就等于以前双击 dist\pichat.exe）。
        // 已经起来的那个后端（上次拉起的 / VS Code 起的 / 终端里起的）就直接接上去。
        _ = EnsureBackendAsync();

        StartLiveTick();

        // 托盘图标：左键开主界面，右键三项（打开主界面 / 打开网页端 / 退出）
        _tray = new TrayUi(ShowMain, OpenWebUi, QuitAll);
        _tray.SetStatus("正在连接后端…");

        RenderSession();
    }

    /// <summary>
    /// 后端没在跑就拉一个起来。界面不用等它：正在连的那条会自己连上（它一直在重试），
    /// 这里只负责把后端叫起来、以及把「正在起」写在状态里。
    /// </summary>
    private async Task EnsureBackendAsync()
    {
        try
        {
            await _host.EnsureAsync(_config.Url, text => { _ = Dispatcher.InvokeAsync(() => OnStatus(text, false)); });
        }
        catch (Exception err)
        {
            _ = Dispatcher.InvokeAsync(() => OnStatus(err.Message, false));
            AppLog.Write("后端没起来：" + err.Message);
        }
    }

    /// <summary>开主界面（托盘左键、菜单第一项、别的进程叫过来时走这条）。</summary>
    public void ShowMain()
    {
        if (_quitting) { return; }
        Dispatcher.Invoke(() =>
        {
            Show();
            ShowInTaskbar = true;
            if (WindowState == WindowState.Minimized) { WindowState = WindowState.Normal; }
            Activate();
            // 被别的窗口压在下面时，先置顶一下再放开（不然点了托盘也跳不上来）
            Topmost = true;
            Topmost = false;
            _inputBox.Focus();
        });
    }

    /// <summary>
    /// 后端说它现在在哪个地址（又被叫起来一次时带着 --url）：跟着换过去。
    /// 后端换端口重启、而这个小窗口一直在跑的时候，靠这一下把连接接回新地址。
    /// </summary>
    public void UseBackendUrl(string url)
    {
        Dispatcher.Invoke(() =>
        {
            if (Backend.Normalize(url) == _backend.Url) { return; }
            ApplyUrl(url);
        });
    }

    /// <summary>托盘菜单里的「打开网页端」：用系统默认浏览器打开这个后端的地址。</summary>
    private void OpenWebUi()
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(_config.Url) { UseShellExecute = true });
        }
        catch
        {
            // 打不开就算了
        }
    }

    /// <summary>托盘菜单里的「退出」：跟终端里按 Ctrl+C 一样，连后端一起收摊，然后自己退。</summary>
    private void QuitAll()
    {
        if (_quitting) { return; }
        SetQuitting();
        // 先让后端收摊（它要停网页服务、杀掉那些会话），再把界面关掉。
        // 自己拉起来的那个后端由 _host 负责确认它真退了（不退就杀）。
        Dispatcher.InvokeAsync(async () =>
        {
            try { await _host.ShutdownAsync(_config.Url); } catch { /* 收不干净也要退 */ }
            Close();
            _app.Shutdown();
        });
    }

    /// <summary>真的要退了：让窗口这次真的关掉、不再退到托盘。</summary>
    public void SetQuitting()
    {
        _quitting = true;
        ShowInTaskbar = true;
    }

    /// <summary>程序收尾：把托盘图标摘掉（不然它会留在通知区域里成一个死图标）。</summary>
    public void DisposeUi()
    {
        try { _tray.Dispose(); } catch { /* 已经没了 */ }
        try { _backend.Stop(); } catch { /* 已经没了 */ }
    }

    // ---------------------------------------------------------------- 界面

    private void BuildUi()
    {
        Title = "Pi Chat";
        MinWidth = 600;
        MinHeight = 400;
        Width = 900;
        Height = 650;
        FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI");
        Background = B("#f5f5f5");

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // 下面：左边会话（底下是「设置」与连接状态），右边内容
        var main = new Grid();
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(280), MinWidth = 180 });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 300 });

        var left = new Grid();
        left.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        left.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        _sessionList = new StackPanel();
        var listScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = _sessionList,
        };
        Grid.SetRow(listScroll, 0);
        left.Children.Add(listScroll);

        // 左下角：一颗齿轮（齿轮图标）+ 现在连到哪儿了。地址那些在它的弹窗里改。
        var footer = new Grid { Margin = new Thickness(10, 0, 10, 8) };
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var settingsButton = new Button
        {
            // 跟界面上那颗「设置」同一个图标（media/chat.js 里 ICONS.sliders：三条滑杆）
            Content = SlidersIcon(Gray),
            Width = 28,
            Height = 28,
            Padding = new Thickness(0),
            HorizontalContentAlignment = HorizontalAlignment.Center,
            VerticalContentAlignment = VerticalAlignment.Center,
            ToolTip = "设置（后端地址）",
        };
        settingsButton.Click += (_, _) => ShowSettings();
        Grid.SetColumn(settingsButton, 0);
        footer.Children.Add(settingsButton);

        _statusText = new TextBlock
        {
            Text = "正在连接后端…",
            Foreground = Orange,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
            ToolTip = "现在和后端的连接状态",
        };
        Grid.SetColumn(_statusText, 1);
        footer.Children.Add(_statusText);
        Grid.SetRow(footer, 1);
        left.Children.Add(footer);

        var leftBorder = new Border
        {
            Background = White,
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 0, 1, 0),
            Child = left,
        };
        Grid.SetColumn(leftBorder, 0);
        main.Children.Add(leftBorder);

        var splitter = new GridSplitter
        {
            Width = 4,
            Background = LightGray,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            ResizeBehavior = GridResizeBehavior.PreviousAndNext,
            ShowsPreview = false,
        };
        Grid.SetColumn(splitter, 1);
        main.Children.Add(splitter);

        var right = new Grid();
        right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        right.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        _messages = new StackPanel();
        _messageScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(12, 10, 12, 4),
            Content = _messages,
        };
        Grid.SetRow(_messageScroll, 0);
        right.Children.Add(_messageScroll);

        // 底下：输入框 + 发送（一样高的一行；提示语写在输入框里，不另占一行）
        var inputGrid = new Grid();
        inputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        inputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        _inputBox = new TextBox
        {
            Height = 30,
            Padding = new Thickness(8, 0, 8, 0),
            VerticalContentAlignment = VerticalAlignment.Center,
            AcceptsReturn = false,
            TextWrapping = TextWrapping.NoWrap,
        };
        _inputBox.KeyDown += InputBox_KeyDown;
        _inputBox.TextChanged += (_, _) => UpdatePlaceholder();
        ToolTipService.SetShowOnDisabled(_inputBox, true);
        Grid.SetColumn(_inputBox, 0);
        inputGrid.Children.Add(_inputBox);

        // 输入框里那行浅灰字（自己画的占位：WPF 的 TextBox 没有这个东西）
        _placeholder = new TextBlock
        {
            Text = "回车发送",
            FontSize = 12,
            Foreground = LightGray,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(11, 0, 0, 0),
            IsHitTestVisible = false,
        };
        Grid.SetColumn(_placeholder, 0);
        inputGrid.Children.Add(_placeholder);

        _sendButton = new Button
        {
            Content = "发送",
            Width = 76,
            Height = 30,
            Margin = new Thickness(8, 0, 0, 0),
        };
        _sendButton.Click += (_, _) => _ = SendInputAsync();
        ToolTipService.SetShowOnDisabled(_sendButton, true);
        Grid.SetColumn(_sendButton, 1);
        inputGrid.Children.Add(_sendButton);

        // 出错才露出来的一行红字（平时收起来，不占地方）
        _hintText = new TextBlock
        {
            Text = "",
            FontSize = 11,
            Foreground = B("#b91c1c"),
            Margin = new Thickness(0, 5, 0, 0),
            TextWrapping = TextWrapping.Wrap,
            Visibility = Visibility.Collapsed,
        };

        var inputStack = new StackPanel();
        inputStack.Children.Add(inputGrid);
        inputStack.Children.Add(_hintText);

        var inputBorder = new Border
        {
            Background = White,
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(14, 10, 14, 10),
            Child = inputStack,
        };
        Grid.SetRow(inputBorder, 1);
        right.Children.Add(inputBorder);

        Grid.SetColumn(right, 2);
        main.Children.Add(right);

        Grid.SetRow(main, 0);
        root.Children.Add(main);

        Content = root;
    }

    private void RestoreWindowBounds()
    {
        var width = _config.Width ?? 900;
        var height = _config.Height ?? 650;
        Width = Math.Max(600, width);
        Height = Math.Max(400, height);

        if (_config.Left is { } left && _config.Top is { } top
            && OnSomeScreen(left, top, Width, Height))
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = left;
            Top = top;
        }
        else
        {
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
    }

    private static bool OnSomeScreen(double left, double top, double width, double height)
    {
        var x = SystemParameters.VirtualScreenLeft;
        var y = SystemParameters.VirtualScreenTop;
        var w = SystemParameters.VirtualScreenWidth;
        var h = SystemParameters.VirtualScreenHeight;
        return left + width > x + 40 && left < x + w - 40 && top + height > y + 40 && top < y + h - 40;
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        var bounds = WindowState == WindowState.Normal
            ? new Rect(Left, Top, Width, Height)
            : RestoreBounds;
        if (bounds.Width >= 600 && bounds.Height >= 400)
        {
            _config.Left = bounds.Left;
            _config.Top = bounds.Top;
            _config.Width = bounds.Width;
            _config.Height = bounds.Height;
        }
        Config.Save(_config);

        if (!_quitting)
        {
            // 点右上角那颗叉只是把窗口收起来：托盘图标还在，左键点它就回来。
            // 真退只有一条路 —— 托盘菜单里的「退出」（见 QuitAll）。
            e.Cancel = true;
            ShowInTaskbar = false;
            Hide();
            return;
        }

        Toast.ForgetAll();
        _tray.Dispose();
        _backend.Stop();
        base.OnClosing(e);
    }

    // ---------------------------------------------------------------- 后端来的东西

    private void OnStatus(string text, bool connected)
    {
        _tray.SetStatus("Pi Chat · " + text);
        _statusText.Text = text;
        _statusText.Foreground = connected ? Green : Orange;
        _statusText.ToolTip = text;
        if (_dialogStatus != null)
        {
            _dialogStatus.Text = text;
            _dialogStatus.Foreground = connected ? Green : Orange;
        }
    }

    private void OnEnded(string reason)
    {
        var text = reason.Length > 0 ? "后端停了：" + reason : "后端停了，不再重连";
        _statusText.Text = text;
        _statusText.Foreground = Orange;
        if (_dialogStatus != null) { _dialogStatus.Text = text; _dialogStatus.Foreground = Orange; }
    }

    private void OnSessions(List<SessionInfo> list, bool withNotes)
    {        var alive = new HashSet<string>();
        foreach (var info in list)
        {
            alive.Add(info.Id);
            if (!_sessions.TryGetValue(info.Id, out var state))
            {
                state = new SessionState();
                _sessions[info.Id] = state;
            }
            state.Info = info;
            if (withNotes)
            {
                state.Notes = info.Notes ?? new List<Note>();
                // 那份现状里带着「这几道题已经答过了」：重新连上以后不该又能点
                foreach (var settled in state.Notes)
                {
                    if (settled.Settled && settled.Ask != null && !_answers.ContainsKey(settled.Ask.CardId))
                    {
                        _answers[settled.Ask.CardId] = "";
                    }
                }
            }
            if (info.Last != null) { AddNote(state, info.Last); }
        }

        foreach (var id in _sessions.Keys.Where(id => !alive.Contains(id)).ToList())
        {
            _sessions.Remove(id);
        }

        // 选着的会话被关掉了
        if (_selectedId != null && !_sessions.ContainsKey(_selectedId)) { _selectedId = null; }

        // 起手要选的会话（命令行指定 > 上次选的 > 最上面那个）
        if (_pendingSelect != null && _sessions.ContainsKey(_pendingSelect))
        {
            var id = _pendingSelect;
            _pendingSelect = null;
            SelectSession(id);
            return;
        }
        if (_selectedId == null && !string.IsNullOrEmpty(_config.LastSessionId) && _sessions.ContainsKey(_config.LastSessionId))
        {
            SelectSession(_config.LastSessionId);
            return;
        }
        if (_selectedId == null && _sessions.Count > 0)
        {
            SelectSession(OrderedSessions().First().Info.Id);
            return;
        }

        RebuildSessionList();
        if (_selectedId == null) { RenderSession(); }
    }

    private void OnNote(Note note)
    {
        if (!_sessions.TryGetValue(note.SessionId, out var state))
        {
            state = new SessionState
            {
                Info = new SessionInfo
                {
                    Id = note.SessionId,
                    Name = note.Name,
                    Remote = note.SessionId.StartsWith("remote:", StringComparison.Ordinal),
                },
            };
            _sessions[note.SessionId] = state;
        }
        state.Info.Last = note;
        if (!string.IsNullOrWhiteSpace(note.Name)) { state.Info.Name = note.Name; }
        AddNote(state, note);
        if (note.Settled && note.Ask != null) { _answers[note.Ask.CardId] = ""; }

        RebuildSessionList();
        if (_selectedId == note.SessionId) { RenderSession(); }

        // 有事就弹一张卡片（自己刚说的那句、还有已经把答案填了的题不算）
        if (note.Kind is "done" or "ask") { MaybeToast(state, note); }
    }

    /// <summary>
    /// 该不该弹那张右下角卡片：人正开着窗口、看的正是这个会话，就不弹（他就在看着）；
    /// 其余情况都弹 —— 窗口收在托盘里、在看别的会话、正在干别的。
    /// </summary>
    private void MaybeToast(SessionState state, Note note)
    {
        var looking = IsVisible && IsActive && _selectedId == note.SessionId;
        if (looking) { return; }
        // note.Name 里已经带了「哪台 · 会话名」（后端推过来时就拼好了），别再叠一层
        var title = note.Name;
        if (note.Kind == "ask") { title = "在等你答一句 · " + title; }
        Toast.Show(note.SessionId, title, PreviewOf(note), note.Kind == "ask", () =>
        {
            ShowMain();
            SelectSession(note.SessionId);
        });
    }

    /// <summary>某道题在别处（网页上、另一台设备上）答过了：那张卡片置灰，别让人再点一次。</summary>
    private void OnAskDone(string cardId)
    {
        if (string.IsNullOrEmpty(cardId) || _answers.ContainsKey(cardId)) { return; }
        _answers[cardId] = "";
        if (_selectedId != null) { RenderSession(); }
    }

    private static void AddNote(SessionState state, Note note)
    {
        if (state.Notes.Any(existing => existing.Seq == note.Seq)) { return; }
        state.Notes.Add(note);
        state.Notes.Sort((left, right) => left.Seq.CompareTo(right.Seq));
    }

    // ---------------------------------------------------------------- 会话列表

    private IEnumerable<SessionState> OrderedSessions() =>
        _sessions.Values
            .OrderByDescending(state => LastAt(state))
            .ThenBy(state => state.Info.Name, StringComparer.CurrentCulture);

    private static long LastAt(SessionState state) =>
        state.Info.Last?.At ?? (state.Notes.Count > 0 ? state.Notes[^1].At : 0);

    private void RebuildSessionList()
    {
        _sessionList.Children.Clear();
        foreach (var state in OrderedSessions())
        {
            _sessionList.Children.Add(MakeSessionRow(state));
        }
    }

    private Border MakeSessionRow(SessionState state)
    {
        var info = state.Info;
        var row1 = new Grid();
        row1.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row1.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var title = new Grid();
        title.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        title.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        // 状态点：跟网页端一个规矩 —— 正在跑是蓝点、呼吸；闲着（跑完了）是绿点、不闪
        var dot = new Ellipse
        {
            Width = 8,
            Height = 8,
            Fill = info.Running ? Blue : Green,
            Margin = new Thickness(0, 0, 5, 0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        dot.ToolTip = info.Running ? "正在跑" : "没在跑";
        if (info.Running) { Breathe(dot); }
        Grid.SetColumn(dot, 0);
        title.Children.Add(dot);
        var nameBlock = new TextBlock
        {
            Text = info.Name,
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = Ink,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(nameBlock, 1);
        title.Children.Add(nameBlock);
        Grid.SetColumn(title, 0);
        row1.Children.Add(title);

        var last = LastNote(state);
        var time = new TextBlock
        {
            Text = TimeLabel(last?.At),
            FontSize = 11,
            Foreground = Gray,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(6, 2, 0, 0),
        };
        Grid.SetColumn(time, 1);
        row1.Children.Add(time);

        var box = new StackPanel();
        box.Children.Add(row1);
        box.Children.Add(new TextBlock
        {
            Text = PreviewOf(last),
            FontSize = 12,
            Foreground = Gray,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(0, 3, 0, 0),
        });

        var badges = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 0) };
        // 别的机器上的会话不另外标：名字前面那个「家里 ·」已经说清了
        if (HasUnansweredAsk(state)) { badges.Children.Add(Badge("在等你答一句", Orange, OrangeBg)); }
        if (badges.Children.Count > 0) { box.Children.Add(badges); }

        var border = new Border
        {
            Padding = new Thickness(12, 9, 12, 9),
            Background = info.Id == _selectedId ? Selected : Brushes.Transparent,
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Cursor = Cursors.Hand,
            Child = box,
            ToolTip = info.Name,
        };
        border.MouseLeftButtonDown += (_, _) => SelectSession(info.Id);
        return border;
    }

    /// <summary>在跑的那颗蓝点：一明一暗地呼吸（跟网页端那颗点一个意思）。</summary>
    private static void Breathe(UIElement dot)
    {
        var fade = new System.Windows.Media.Animation.DoubleAnimation
        {
            From = 1.0,
            To = 0.3,
            Duration = TimeSpan.FromMilliseconds(700),
            AutoReverse = true,
            RepeatBehavior = System.Windows.Media.Animation.RepeatBehavior.Forever,
        };
        dot.BeginAnimation(OpacityProperty, fade);
    }

    /// <summary>activity 那几个词说成人话（后端给的是 thinking / working / idle 这些）。</summary>
    private static string ActivityLabel(string? activity) => activity switch
    {
        "thinking" => "在想",
        "working" => "在干",
        "idle" => "",
        _ => activity ?? "",
    };

    private static Border Badge(string text, Brush foreground, Brush background) => new()
    {
        Background = background,
        CornerRadius = new CornerRadius(4),
        Padding = new Thickness(5, 1, 5, 1),
        Margin = new Thickness(0, 0, 6, 0),
        Child = new TextBlock { Text = text, FontSize = 11, Foreground = foreground },
    };

    private bool HasUnansweredAsk(SessionState state) =>
        state.Notes.Any(note => note.Kind == "ask"
            && note.Ask != null
            && !_answers.ContainsKey(note.Ask.CardId));

    private static Note? LastNote(SessionState state) =>
        state.Info.Last ?? (state.Notes.Count > 0 ? state.Notes[^1] : null);

    private void SelectSession(string id)
    {
        if (_selectedId == id) { return; }
        _selectedId = id;
        _config.LastSessionId = id;
        Config.Save(_config);
        RebuildSessionList();
        RenderSession();
        _ = LoadFullSessionAsync(id);
    }

    private async Task LoadFullSessionAsync(string id)
    {
        var (session, notes, reason, lastReply) = await _backend.LoadSessionAsync(id);
        if (_selectedId != id) { return; }
        if (!_sessions.TryGetValue(id, out var state)) { return; }

        if (session == null)
        {
            if (reason.Length > 0) { SetHint("这个会话拉不全：" + reason, true); }
            return;
        }
        state.Info = session;
        state.Notes = notes ?? new List<Note>();
        _lastReply = lastReply;
        RebuildSessionList();
        RenderSession();

    }

    /// <summary>开着窗口就每 4 秒拉一次当前会话（「这一轮」那张卡片要跟着长出来）。</summary>
    private void StartLiveTick()
    {
        _liveTimer.Tick += (_, _) =>
        {
            if (!IsVisible || _selectedId is null) { return; }
            _ = LoadFullSessionAsync(_selectedId);
        };
        _liveTimer.Start();
    }

    // ---------------------------------------------------------------- 右边那一块

    private void RenderSession()
    {
        _messages.Children.Clear();

        SessionState? state = null;
        if (_selectedId != null) { _sessions.TryGetValue(_selectedId, out state); }

        if (state == null)
        {
            _inputBox.IsEnabled = false;
            _sendButton.IsEnabled = false;
            _inputBox.Clear();
            _hintText.Text = "";
            _hintText.Visibility = Visibility.Collapsed;
            SetHint("先挑一个会话", false);
            return;
        }

        var canReply = true;
        _inputBox.IsEnabled = canReply;
        _sendButton.IsEnabled = canReply;
        _inputBox.ToolTip = state.Info.Remote ? "这是别的机器上的会话：这句话会转给那台" : null;
        _sendButton.ToolTip = _inputBox.ToolTip;
        SetHint("回车发送", false);

        foreach (var note in state.Notes)
        {
            _messages.Children.Add(MakeBubble(state, note));
        }

        // 「这一轮」摆在最后（跟聊天一样，最新的在最底下）：正在跑的时候能看它说到哪儿了；
        // 一条「有事」都还没有的时候也摆它 —— 那是刚重启过后端 / 这台才刚连上来，
        // 「有事」早就没了，而拉回来的那条最后回复还在（见 LoadFullSessionAsync），
        // 不摆的话人就只能对着一屏空白等下一次推送。
        // 跑完了、也已经收到过「有事」的话不摆：那一轮的原话就是最后那条，不必两份。
        if (state.Info.Running || state.Notes.Count == 0)
        {
            var live = MakeLiveCard(state);
            _messages.Children.Add(live);
            // 滚到卡片开头（这样「正在跑…」那一行也看得到），而不是一路到底
            Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => live.BringIntoView()));
            return;
        }

        Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => _messageScroll.ScrollToEnd()));
    }

    private FrameworkElement MakeBubble(SessionState state, Note note)
    {
        var mine = note.Kind == "me";
        var stack = new StackPanel();

        if (note.Kind == "ask")
        {
            stack.Children.Add(new TextBlock
            {
                Text = "在等你答一句",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = Orange,
                Margin = new Thickness(0, 0, 0, 4),
            });
        }

        stack.Children.Add(Markdown.Render(note.Blocks, note.Text, 13, Ink, Gray));

        if (note.Kind == "ask" && note.Ask != null)
        {
            stack.Children.Add(MakeAskCard(state, note, note.Ask));
        }

        var footer = TimeText(note.At);
        if (!string.IsNullOrWhiteSpace(note.From)) { footer += " · " + note.From; }
        stack.Children.Add(new TextBlock
        {
            Text = footer,
            FontSize = 10,
            Foreground = Gray,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 4, 0, 0),
        });

        return new Border
        {
            Background = mine ? Mine : (note.Kind == "ask" ? AskBg : White),
            BorderBrush = Line,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10, 8, 10, 8),
            MaxWidth = 520,
            HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            Margin = new Thickness(0, 0, 0, 8),
            Child = stack,
        };
    }

    /// <summary>「这一轮」那张卡：正在跑就在这儿看它说到哪儿了。</summary>
    private FrameworkElement MakeLiveCard(SessionState state)
    {
        var info = state.Info;
        var stack = new StackPanel();

        var head = new StackPanel { Orientation = Orientation.Horizontal };
        var dot = new Ellipse
        {
            Width = 8,
            Height = 8,
            Fill = info.Running ? Blue : Green,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 6, 0),
        };
        if (info.Running) { Breathe(dot); }
        head.Children.Add(dot);
        var what = info.Running
            ? (string.IsNullOrWhiteSpace(info.ActivityDetail) ? (ActivityLabel(info.Activity) is { Length: > 0 } label ? label + "…" : "正在跑…") : info.ActivityDetail!)
            : "这一轮已经跑完了";
        head.Children.Add(new TextBlock
        {
            Text = what,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = info.Running ? Blue : Green,
            VerticalAlignment = VerticalAlignment.Center,
        });
        stack.Children.Add(head);

        var reply = _lastReply;
        if (reply is null || string.IsNullOrWhiteSpace(reply.Text))
        {
            stack.Children.Add(new TextBlock
            {
                Text = info.Running ? "（还没开始说话）" : "（这个会话还没有跑完过一轮）",
                FontSize = 12,
                Foreground = Gray,
                Margin = new Thickness(0, 6, 0, 0),
            });
        }
        else
        {
            stack.Children.Add(new Border
            {
                Margin = new Thickness(0, 6, 0, 0),
                Child = Markdown.Render(reply.Blocks, reply.Text ?? "", 13, Ink, Gray),
            });
        }

        return new Border
        {
            Background = White,
            BorderBrush = Line,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 9, 12, 9),
            Margin = new Thickness(0, 0, 0, 8),
            MaxWidth = 620,
            HorizontalAlignment = HorizontalAlignment.Left,
            Child = stack,
        };
    }

    private FrameworkElement MakeAskCard(SessionState state, Note note, Ask ask)
    {
        var answered = _answers.TryGetValue(ask.CardId, out var answer);
        var canAnswer = !answered;

        var panel = new StackPanel { Margin = new Thickness(0, 6, 0, 0), Opacity = answered ? 0.6 : 1 };
        var optionControls = new List<FrameworkElement>();
        var options = ask.Options ?? new List<string>();

        for (var i = 0; i < options.Count; i++)
        {
            var text = options[i];
            if (ask.Recommended?.Contains(i + 1) == true) { text += "（我推荐）"; }

            if (ask.Multi)
            {
                var checkBox = new CheckBox
                {
                    Content = text,
                    Tag = options[i],
                    IsEnabled = canAnswer,
                    Margin = new Thickness(0, 2, 0, 2),
                };
                optionControls.Add(checkBox);
                panel.Children.Add(checkBox);
            }
            else
            {
                var radioButton = new RadioButton
                {
                    Content = text,
                    Tag = options[i],
                    GroupName = "ask-" + ask.CardId,
                    IsEnabled = canAnswer,
                    Margin = new Thickness(0, 2, 0, 2),
                };
                optionControls.Add(radioButton);
                panel.Children.Add(radioButton);
            }
        }

        TextBox? freeBox = null;
        if (ask.AllowText)
        {
            var freeRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 0) };
            freeRow.Children.Add(new TextBlock
            {
                Text = "自己写：",
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
            });
            freeBox = new TextBox
            {
                Width = 240,
                Padding = new Thickness(4, 2, 4, 2),
                IsEnabled = canAnswer,
            };
            freeRow.Children.Add(freeBox);
            panel.Children.Add(freeRow);
        }

        var result = new TextBlock
        {
            Text = answered ? (string.IsNullOrEmpty(answer) ? "已答" : "已答：" + answer) : "",
            FontSize = 12,
            Foreground = answered ? Gray : Orange,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
        };

        var button = new Button
        {
            Content = "发送这个回答",
            HorizontalAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(10, 2, 10, 2),
            Margin = new Thickness(0, 6, 0, 0),
            IsEnabled = canAnswer,
        };
        button.Click += (_, _) => SubmitAnswer(note, optionControls, freeBox, result, button);

        panel.Children.Add(button);
        panel.Children.Add(result);
        return panel;
    }

    private async void SubmitAnswer(Note note, List<FrameworkElement> optionControls, TextBox? freeBox, TextBlock result, Button button)
    {
        if (note.Ask == null) { return; }

        var picks = new List<string>();
        foreach (var control in optionControls)
        {
            if (control is RadioButton radio && radio.IsChecked == true && radio.Tag is string radioText) { picks.Add(radioText); }
            if (control is CheckBox check && check.IsChecked == true && check.Tag is string checkText) { picks.Add(checkText); }
        }
        var free = freeBox?.Text?.Trim() ?? "";
        if (picks.Count == 0 && free.Length == 0)
        {
            result.Text = "先勾一项，或者在「自己写」里写一句";
            result.Foreground = Orange;
            return;
        }

        button.IsEnabled = false;
        var summary = string.Join("、", picks);
        if (free.Length > 0) { summary = summary.Length > 0 ? summary + "；" + free : free; }

        var (ok, reason) = await _backend.AnswerAsync(note.Ask.CardId, picks, free);
        if (!ok)
        {
            button.IsEnabled = true;
            result.Text = "没答上：" + reason;
            result.Foreground = B("#b91c1c");
            return;
        }

        _answers[note.Ask.CardId] = summary;
        RebuildSessionList();
        RenderSession();
    }

    // ---------------------------------------------------------------- 发一句话

    private void InputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0)
        {
            e.Handled = true;
            _ = SendInputAsync();
        }
    }

    private async Task SendInputAsync()
    {
        if (_selectedId == null || !_sessions.TryGetValue(_selectedId, out var state)) { return; }
        var sessionId = _selectedId;
        var text = _inputBox.Text?.Trim() ?? "";
        if (text.Length == 0) { return; }

        _sendButton.IsEnabled = false;
        var (ok, reason) = await _backend.SendAsync(sessionId, text);

        // 等后端那一下里换到别的会话去了：这句话已经发出去了，但别把新会话的输入框清掉
        if (_selectedId != sessionId)
        {
            RenderSession();
            return;
        }
        _sendButton.IsEnabled = true;

        if (ok)
        {
            _inputBox.Clear();
            SetHint("回车发送", false);
            _inputBox.Focus();
        }
        else
        {
            SetHint("没发出去：" + reason, true);
        }
    }

    /// <summary>
    /// 底下那条提示：平时是输入框里的浅灰字（回车发送 / 先挑一个会话）；
    /// 出了错才在输入框下面多出一行红字（那时它比占位字管用）。
    /// </summary>
    private void SetHint(string text, bool isError)
    {
        if (isError)
        {
            _hintText.Text = text;
            _hintText.Visibility = Visibility.Visible;
            return;
        }
        _hintText.Text = "";
        _hintText.Visibility = Visibility.Collapsed;
        _placeholder.Text = text;
        UpdatePlaceholder();
    }

    /** 输入框里那行浅灰字：里面有字就藏起来。 */
    private void UpdatePlaceholder()
    {
        _placeholder.Visibility = _inputBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ApplyUrl(string raw)
    {
        var url = Backend.Normalize(raw);
        if (!Backend.IsValid(url))
        {
            OnStatus("地址写得不对，要像 http://127.0.0.1:51883 这样", false);
            return;
        }
        if (url == _backend.Url) { OnStatus("已经连的就是这个地址", false); return; }

        _config.Url = url;
        Config.Save(_config);
        _sessions.Clear();
        _selectedId = null;
        _answers.Clear();
        RebuildSessionList();
        RenderSession();
        _backend.SetUrl(url);
        OnStatus("正在连接后端…", false);
    }

    // ---------------------------------------------------------------- 小工具

    /// <summary>
    /// 设置那颗按钮上的图标：跟界面上那颗「设置」一模一样（三条滑杆，见 media/chat.js 的 ICONS.sliders）。
    /// 那个是 16×16 的 SVG（fill:none、描边 1.4）；这里用一丘 Canvas 把同样的几笔画出来。
    /// </summary>
    private static FrameworkElement SlidersIcon(Brush color)
    {
        const double stroke = 1.4;
        var canvas = new Canvas { Width = 16, Height = 16 };

        void Bar(double x1, double y1, double x2, double y2)
        {
            canvas.Children.Add(new Line
            {
                X1 = x1, Y1 = y1, X2 = x2, Y2 = y2,
                Stroke = color,
                StrokeThickness = stroke,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            });
        }
        void Knob(double cx, double cy, double r)
        {
            var circle = new Ellipse
            {
                Width = r * 2,
                Height = r * 2,
                Stroke = color,
                StrokeThickness = stroke,
                Fill = null,
            };
            Canvas.SetLeft(circle, cx - r);
            Canvas.SetTop(circle, cy - r);
            canvas.Children.Add(circle);
        }

        Bar(2, 4.5, 8.2, 4.5);
        Bar(11.8, 4.5, 14, 4.5);
        Bar(2, 11.5, 3.7, 11.5);
        Bar(7.3, 11.5, 14, 11.5);
        Knob(10, 4.5, 1.8);
        Knob(5.5, 11.5, 1.8);

        return new Viewbox { Width = 19, Height = 19, Child = canvas };
    }

    /// <summary>
    /// 左下角那颗齿轮：弹一个小窗口换后端地址（不在主界面上占地方）。
    /// 窗口里那行状态跟着主界面一起变（连没连上看得到），点「关闭」/按 Esc 回去。
    /// </summary>
    private void ShowSettings()
    {
        var dialog = new Window
        {
            Title = "设置",
            Owner = this,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            SizeToContent = SizeToContent.Height,
            Width = 400,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            Background = White,
            FontFamily = FontFamily,
        };

        var panel = new StackPanel { Margin = new Thickness(18, 16, 18, 16) };
        panel.Children.Add(new TextBlock
        {
            Text = "后端地址",
            FontSize = 12,
            Foreground = Gray,
            Margin = new Thickness(0, 0, 0, 6),
        });
        var urlBox = new TextBox
        {
            Height = 28,
            Padding = new Thickness(6, 0, 6, 0),
            VerticalContentAlignment = VerticalAlignment.Center,
            Text = _config.Url,
            ToolTip = "像 http://127.0.0.1:51883 这样；换了点「连接」，下次打开还用它",
        };
        panel.Children.Add(urlBox);

        _dialogStatus = new TextBlock
        {
            Text = _statusText.Text,
            Foreground = _statusText.Foreground,
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 0),
        };
        panel.Children.Add(_dialogStatus);

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 16, 0, 0),
        };
        var connect = new Button { Content = "连接", Padding = new Thickness(16, 3, 16, 3), IsDefault = true };
        connect.Click += (_, _) => ApplyUrl(urlBox.Text);
        var close = new Button { Content = "关闭", Padding = new Thickness(16, 3, 16, 3), Margin = new Thickness(8, 0, 0, 0), IsCancel = true };
        close.Click += (_, _) => dialog.Close();
        buttons.Children.Add(connect);
        buttons.Children.Add(close);
        panel.Children.Add(buttons);

        dialog.Content = panel;
        dialog.Closed += (_, _) => { _dialogStatus = null; };
        dialog.ShowDialog();
        // 关掉以后手能接着打字
        _inputBox.Focus();
    }

    private static string TimeLabel(long? milliseconds)
    {
        if (milliseconds is not > 0) { return ""; }
        var at = DateTimeOffset.FromUnixTimeMilliseconds(milliseconds.Value).LocalDateTime;
        var now = DateTime.Now;
        if (at.Date == now.Date) { return at.ToString("HH:mm"); }
        return at.Year == now.Year ? at.ToString("MM-dd") : at.ToString("yyyy-MM-dd");
    }

    private static string TimeText(long milliseconds)
    {
        if (milliseconds <= 0) { return ""; }
        var at = DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).LocalDateTime;
        var now = DateTime.Now;
        return at.Date == now.Date ? at.ToString("HH:mm") : at.ToString("MM-dd HH:mm");
    }

    /// <summary>列表第二行写最后一条通知的第一句。</summary>
    /// <summary>列表上那一行：后端已经压好的那句话（老后端没有就自己截一下）。</summary>
    private static string PreviewOf(Note? note)
    {
        if (note is null) { return ""; }
        var plain = string.IsNullOrWhiteSpace(note.Plain) ? FirstLine(note.Text) : note.Plain!.Trim();
        if (plain.Length > 40) { plain = plain[..40] + "…"; }
        return plain;
    }

    /// <summary>只取头一行（老后端没有 plain 时的兜底）。</summary>
    private static string FirstLine(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) { return ""; }
        var line = text.Replace("\r", "").Split('\n').FirstOrDefault(item => item.Trim().Length > 0)?.Trim() ?? "";
        var cut = line.IndexOfAny(new[] { '。', '！', '？', '!', '?' });
        if (cut > 0) { line = line[..cut]; }
        if (line.Length > 40) { line = line[..40] + "…"; }
        return line;
    }
}

/// <summary>%APPDATA%\PiChat\config.json：后端地址、窗口大小位置、上次选的会话。</summary>
internal sealed class Config
{
    public string Url { get; set; } = "http://127.0.0.1:51883";
    public double? Left { get; set; }
    public double? Top { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }
    public string? LastSessionId { get; set; }

    private static string Folder =>
        IOPath.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PiChat");

    private static string FilePath => IOPath.Combine(Folder, "config.json");

    public static Config Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var config = JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath), Json.Options);
                if (config != null)
                {
                    if (string.IsNullOrWhiteSpace(config.Url)) { config.Url = "http://127.0.0.1:51883"; }
                    return config;
                }
            }
        }
        catch
        {
            // 配置坏了就用默认的，不拦着启动
        }
        return new Config();
    }

    public static void Save(Config config)
    {
        try
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch
        {
            // 写不进去就下次再说
        }
    }
}
