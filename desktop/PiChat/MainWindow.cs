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
    private TextBox _urlBox = null!;
    private StackPanel _sessionList = null!;
    private StackPanel _messages = null!;
    private ScrollViewer _messageScroll = null!;
    private TextBlock _titleText = null!;
    private TextBlock _subtitleText = null!;
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

    public MainWindow(StartupOptions options)
    {
        _config = Config.Load();
        if (!string.IsNullOrWhiteSpace(options.Url))
        {
            _config.Url = Backend.Normalize(options.Url);
            Config.Save(_config);
        }
        if (!Backend.IsValid(_config.Url)) { _config.Url = "http://127.0.0.1:51991"; }
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

        _urlBox.Text = _config.Url;
        RenderSession();
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
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // 顶上一条：连接状态 + 后端地址
        var top = new Grid { Margin = new Thickness(12, 8, 12, 8) };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(230) });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        _statusText = new TextBlock
        {
            Text = "正在连接后端…",
            Foreground = Orange,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(_statusText, 0);
        top.Children.Add(_statusText);

        var urlLabel = new TextBlock
        {
            Text = "后端地址",
            Foreground = Gray,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 6, 0),
        };
        Grid.SetColumn(urlLabel, 1);
        top.Children.Add(urlLabel);

        _urlBox = new TextBox
        {
            Height = 26,
            Padding = new Thickness(6, 0, 6, 0),
            VerticalContentAlignment = VerticalAlignment.Center,
            Text = _config.Url,
            ToolTip = "换了地址点「连接」；下次打开还用它",
        };
        Grid.SetColumn(_urlBox, 2);
        top.Children.Add(_urlBox);

        var connectButton = new Button
        {
            Content = "连接",
            Padding = new Thickness(12, 2, 12, 2),
            Margin = new Thickness(6, 0, 0, 0),
        };
        connectButton.Click += (_, _) => ApplyUrl();
        _urlBox.KeyDown += (_, e) =>
        {
            if (e.Key == Key.Enter) { e.Handled = true; ApplyUrl(); }
        };
        Grid.SetColumn(connectButton, 3);
        top.Children.Add(connectButton);

        var topBorder = new Border
        {
            Background = White,
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = top,
        };
        Grid.SetRow(topBorder, 0);
        root.Children.Add(topBorder);

        // 下面：左边会话，右边内容
        var main = new Grid();
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(280), MinWidth = 180 });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 300 });

        var left = new Grid();
        left.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        left.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var leftTitle = new TextBlock
        {
            Text = "会话",
            FontWeight = FontWeights.SemiBold,
            FontSize = 13,
            Foreground = Gray,
            Margin = new Thickness(12, 10, 12, 8),
        };
        Grid.SetRow(leftTitle, 0);
        left.Children.Add(leftTitle);

        _sessionList = new StackPanel();
        var listScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = _sessionList,
        };
        Grid.SetRow(listScroll, 1);
        left.Children.Add(listScroll);

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
        right.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        right.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var header = new StackPanel { Margin = new Thickness(14, 10, 14, 10) };
        _titleText = new TextBlock
        {
            Text = "挑一个会话",
            FontSize = 16,
            FontWeight = FontWeights.SemiBold,
            Foreground = Ink,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        _subtitleText = new TextBlock
        {
            Text = "左边点一个会话",
            FontSize = 12,
            Foreground = Gray,
            Margin = new Thickness(0, 3, 0, 0),
            TextWrapping = TextWrapping.Wrap,
        };
        header.Children.Add(_titleText);
        header.Children.Add(_subtitleText);
        var headerBorder = new Border
        {
            Background = White,
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = header,
        };
        Grid.SetRow(headerBorder, 0);
        right.Children.Add(headerBorder);

        _messages = new StackPanel();
        _messageScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(12, 10, 12, 4),
            Content = _messages,
        };
        Grid.SetRow(_messageScroll, 1);
        right.Children.Add(_messageScroll);

        // 底下：输入框 + 发送
        var inputGrid = new Grid();
        inputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        inputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        inputGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        inputGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        _inputBox = new TextBox
        {
            MinHeight = 56,
            MaxHeight = 110,
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(6, 5, 6, 5),
        };
        _inputBox.KeyDown += InputBox_KeyDown;
        ToolTipService.SetShowOnDisabled(_inputBox, true);
        Grid.SetColumn(_inputBox, 0);
        inputGrid.Children.Add(_inputBox);

        _sendButton = new Button
        {
            Content = "发送",
            Width = 76,
            Height = 32,
            Margin = new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        _sendButton.Click += (_, _) => _ = SendInputAsync();
        ToolTipService.SetShowOnDisabled(_sendButton, true);
        Grid.SetColumn(_sendButton, 1);
        inputGrid.Children.Add(_sendButton);

        _hintText = new TextBlock
        {
            Text = "回车发送，Shift+回车换行",
            FontSize = 11,
            Foreground = Gray,
            Margin = new Thickness(0, 5, 0, 0),
        };
        Grid.SetRow(_hintText, 1);
        Grid.SetColumnSpan(_hintText, 2);
        inputGrid.Children.Add(_hintText);

        var inputBorder = new Border
        {
            Background = White,
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(14, 10, 14, 10),
            Child = inputGrid,
        };
        Grid.SetRow(inputBorder, 2);
        right.Children.Add(inputBorder);

        Grid.SetColumn(right, 2);
        main.Children.Add(right);

        Grid.SetRow(main, 1);
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
        _backend.Stop();
        base.OnClosing(e);
    }

    // ---------------------------------------------------------------- 后端来的东西

    private void OnStatus(string text, bool connected)
    {
        _statusText.Text = text;
        _statusText.Foreground = connected ? Green : Orange;
        _statusText.ToolTip = text;
    }

    private void OnEnded(string reason)
    {
        _statusText.Text = reason.Length > 0 ? "后端停了：" + reason : "后端停了，不再重连";
        _statusText.Foreground = Orange;
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
        if (_selectedId == null) { RenderSession(); } else { UpdateHeader(); }
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
        if (info.Running)
        {
            var dot = new Ellipse
            {
                Width = 8,
                Height = 8,
                Fill = Blue,
                Margin = new Thickness(0, 0, 5, 0),
                VerticalAlignment = VerticalAlignment.Center,
            };
            dot.ToolTip = "正在跑";
            Grid.SetColumn(dot, 0);
            title.Children.Add(dot);
        }
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
            Text = FirstLine(last?.Text ?? ""),
            FontSize = 12,
            Foreground = Gray,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(0, 3, 0, 0),
        });

        var badges = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 0) };
        if (HasUnansweredAsk(state)) { badges.Children.Add(Badge("在等你答一句", Orange, OrangeBg)); }
        if (info.Remote) { badges.Children.Add(Badge("别的机器推来的", Gray, LightGray)); }
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
        var (session, notes, reason) = await _backend.LoadSessionAsync(id);
        if (_selectedId != id) { return; }
        if (!_sessions.TryGetValue(id, out var state)) { return; }

        if (session == null)
        {
            if (reason.Length > 0) { SetHint("这个会话拉不全：" + reason, true); }
            return;
        }
        state.Info = session;
        state.Notes = notes ?? new List<Note>();
        RebuildSessionList();
        RenderSession();
    }

    // ---------------------------------------------------------------- 右边那一块

    private void UpdateHeader()
    {
        if (_selectedId != null && _sessions.TryGetValue(_selectedId, out var state))
        {
            _titleText.Text = state.Info.Name;
            _subtitleText.Text = SubtitleOf(state.Info);
        }
        else
        {
            _titleText.Text = "挑一个会话";
            _subtitleText.Text = _sessions.Count == 0 ? "左边还没有会话，等后端推过来" : "左边点一个会话";
        }
    }

    private static string SubtitleOf(SessionInfo info)
    {
        if (info.Remote) { return "别的机器上的会话（这里说的话会转给那台）"; }
        return info.Running ? "正在跑" : "没有在跑";
    }

    private void RenderSession()
    {
        UpdateHeader();
        _messages.Children.Clear();

        SessionState? state = null;
        if (_selectedId != null) { _sessions.TryGetValue(_selectedId, out state); }

        if (state == null)
        {
            _inputBox.IsEnabled = false;
            _sendButton.IsEnabled = false;
            _inputBox.Clear();
            _hintText.Text = "先挑一个会话";
            _hintText.Foreground = Gray;
            return;
        }

        var canReply = true;
        _inputBox.IsEnabled = canReply;
        _sendButton.IsEnabled = canReply;
        _inputBox.ToolTip = state.Info.Remote ? "这是别的机器上的会话：这句话会转给那台" : null;
        _sendButton.ToolTip = _inputBox.ToolTip;
        SetHint("回车发送，Shift+回车换行", false);

        if (state.Notes.Count == 0)
        {
            _messages.Children.Add(new TextBlock
            {
                Text = "这个会话还没有消息。",
                FontSize = 12,
                Foreground = Gray,
                Margin = new Thickness(2, 6, 0, 0),
            });
            return;
        }

        foreach (var note in state.Notes)
        {
            _messages.Children.Add(MakeBubble(state, note));
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

        stack.Children.Add(new TextBlock
        {
            Text = note.Text,
            FontSize = 13,
            LineHeight = 20,
            TextWrapping = TextWrapping.Wrap,
            Foreground = Ink,
        });

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
            SetHint("回车发送，Shift+回车换行", false);
            _inputBox.Focus();
        }
        else
        {
            SetHint("没发出去：" + reason, true);
        }
    }

    private void SetHint(string text, bool isError)
    {
        _hintText.Text = text;
        _hintText.Foreground = isError ? B("#b91c1c") : Gray;
    }

    private void ApplyUrl()
    {
        var url = Backend.Normalize(_urlBox.Text);
        if (!Backend.IsValid(url))
        {
            OnStatus("地址写得不对，要像 http://127.0.0.1:51991 这样", false);
            return;
        }
        _urlBox.Text = url;
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
    public string Url { get; set; } = "http://127.0.0.1:51991";
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
                    if (string.IsNullOrWhiteSpace(config.Url)) { config.Url = "http://127.0.0.1:51991"; }
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
