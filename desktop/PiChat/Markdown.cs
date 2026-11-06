using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace PiChat;

/// <summary>
/// 把一条回复画出来：段落、标题、列表、表格、引用、代码块、分隔线，加上行内的粗体 / 斜体 /
/// 删除线 / 行内代码 / 链接文字。
///
/// **解析不在这儿**：后端推过来的每条通知里已经带好一份「怎么画」的结构（见 src/markdownBlocks.ts），
/// 这里只负责照着画。手机那个 app 也是这么干的 —— 同一段字在两边画得一样，加新东西也只用改后端。
/// 老后端推来的没有这份结构，那就把整段文字当一段画（丑一点，但不会少字）。
/// </summary>
internal static class Markdown
{
    private static readonly FontFamily Mono = new("Consolas, Cascadia Mono, Courier New");
    private static readonly Brush CodeBg = Freeze("#f1f2f4");
    private static readonly Brush CodeBorder = Freeze("#e2e4e8");
    private static readonly Brush LinkColor = Freeze("#1a5fb4");
    private static readonly Brush RuleColor = Freeze("#e5e7eb");

    /// <summary>画成一摞块（直接塞进气泡里）。</summary>
    /// <param name="blocks">后端解析好的结构；没有就退到 <paramref name="fallbackText"/></param>
    public static FrameworkElement Render(IReadOnlyList<MdBlock>? blocks, string fallbackText, double fontSize, Brush ink, Brush subtle)
    {
        if (blocks is null || blocks.Count == 0)
        {
            var text = new TextBlock
            {
                FontSize = fontSize,
                Foreground = ink,
                TextWrapping = TextWrapping.Wrap,
                LineHeight = fontSize * 1.65,
                Text = fallbackText ?? "",
            };
            return text;
        }

        var panel = new StackPanel();
        for (var i = 0; i < blocks.Count; i++)
        {
            var element = MakeBlock(blocks[i], fontSize, ink, subtle);
            if (i < blocks.Count - 1) { element = WithBottomGap(element, fontSize * 0.65); }
            panel.Children.Add(element);
        }
        return panel;
    }

    // ======================================================================
    //  块 → 控件
    // ======================================================================

    private static FrameworkElement MakeBlock(MdBlock block, double fontSize, Brush ink, Brush subtle)
    {
        switch (block.Kind)
        {
            case "p":
                {
                    var text = TextBlockOf(block.Runs, fontSize, ink);
                    text.LineHeight = fontSize * 1.65;
                    return text;
                }

            case "h":
                {
                    var level = Math.Clamp(block.Level, 1, 6);
                    var size = level switch { 1 => 1.45, 2 => 1.3, 3 => 1.15, _ => 1.05 };
                    var text = TextBlockOf(block.Runs, fontSize * size, ink, bold: true);
                    text.Margin = new Thickness(0, level <= 2 ? fontSize * 0.35 : 0, 0, 0);
                    return text;
                }

            case "l":
                {
                    var panel = new StackPanel { Margin = new Thickness(4, 0, 0, 0) };
                    foreach (var item in block.Items ?? new List<MdItem>())
                    {
                        var row = new Grid { Margin = new Thickness(0, 0, 0, fontSize * 0.25) };
                        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                        var bullet = new TextBlock
                        {
                            Text = item.Marker ?? "•",
                            FontSize = fontSize,
                            Foreground = subtle,
                            Margin = new Thickness(block.Ordered ? 2 : 4, 0, 8, 0),
                            VerticalAlignment = VerticalAlignment.Top,
                        };
                        Grid.SetColumn(bullet, 0);
                        var body = TextBlockOf(item.Runs, fontSize, ink);
                        body.LineHeight = fontSize * 1.65;
                        Grid.SetColumn(body, 1);
                        row.Children.Add(bullet);
                        row.Children.Add(body);
                        panel.Children.Add(row);
                    }
                    return panel;
                }

            case "code":
                {
                    // 只读的 TextBox：能选、能复制，横向能滚（长命令 / 长路径不会被折断）
                    var box = new TextBox
                    {
                        Text = block.Value ?? "",
                        IsReadOnly = true,
                        BorderThickness = new Thickness(0),
                        Background = Brushes.Transparent,
                        FontFamily = Mono,
                        FontSize = fontSize - 1,
                        TextWrapping = TextWrapping.NoWrap,
                        HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                        VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                        Padding = new Thickness(0),
                        IsReadOnlyCaretVisible = false,
                    };
                    return new Border
                    {
                        Background = CodeBg,
                        BorderBrush = CodeBorder,
                        BorderThickness = new Thickness(1),
                        CornerRadius = new CornerRadius(6),
                        Padding = new Thickness(10, 8, 10, 8),
                        Child = box,
                    };
                }

            case "q":
                {
                    return new Border
                    {
                        Background = CodeBg,
                        BorderBrush = RuleColor,
                        BorderThickness = new Thickness(3, 0, 0, 0),
                        Padding = new Thickness(10, 6, 8, 6),
                        Child = TextBlockOf(block.Runs, fontSize, subtle),
                    };
                }

            case "hr":
                {
                    return new Border
                    {
                        Height = 1,
                        Background = RuleColor,
                        Margin = new Thickness(0, 2, 0, 2),
                    };
                }

            case "t":
                {
                    var align = block.Align ?? new List<int>();
                    var grid = new Grid { HorizontalAlignment = HorizontalAlignment.Left };
                    for (var c = 0; c < align.Count; c++)
                    {
                        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    }
                    var rows = block.Grid ?? new List<List<List<MdRun>>>();
                    for (var r = 0; r < rows.Count; r++)
                    {
                        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                        var cells = rows[r];
                        for (var c = 0; c < align.Count; c++)
                        {
                            var runs = c < cells.Count ? cells[c] : null;
                            var cellText = TextBlockOf(runs, fontSize - 1, ink, bold: r == 0);
                            cellText.TextAlignment = align[c] switch
                            {
                                1 => TextAlignment.Center,
                                2 => TextAlignment.Right,
                                _ => TextAlignment.Left,
                            };
                            cellText.TextWrapping = TextWrapping.NoWrap;
                            var cell = new Border
                            {
                                BorderBrush = CodeBorder,
                                BorderThickness = new Thickness(0, r > 0 ? 1 : 0, c > 0 ? 1 : 0, r == 0 ? 1 : 0),
                                Background = r == 0 ? CodeBg : Brushes.Transparent,
                                Padding = new Thickness(8, 4, 8, 4),
                                Child = cellText,
                            };
                            Grid.SetRow(cell, r);
                            Grid.SetColumn(cell, c);
                            grid.Children.Add(cell);
                        }
                    }
                    // 列一多就横向滚（挤窄了反而看不清）
                    return new ScrollViewer
                    {
                        HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                        VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                        Content = grid,
                    };
                }

            default:
                return new TextBlock { Text = "", FontSize = fontSize };
        }
    }

    private static TextBlock TextBlockOf(IReadOnlyList<MdRun>? runs, double fontSize, Brush ink, bool bold = false)
    {
        var block = new TextBlock
        {
            FontSize = fontSize,
            Foreground = ink,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = fontSize * 1.6,
        };
        if (bold) { block.FontWeight = FontWeights.SemiBold; }
        AddRuns(block, runs, fontSize, ink);
        return block;
    }

    /// <summary>把一段行内内容（几截带样式的字）塞进 TextBlock。</summary>
    private static void AddRuns(TextBlock block, IReadOnlyList<MdRun>? runs, double fontSize, Brush ink)
    {
        if (runs is null) { return; }
        foreach (var run in runs)
        {
            var text = run.Value ?? "";
            if (text.Length == 0) { continue; }

            // 换行：后端把段落里的换行原样留在字里（跟网页端 breaks: true 一个意思）
            var pieces = text.Split('\n');
            for (var p = 0; p < pieces.Length; p++)
            {
                if (p > 0) { block.Inlines.Add(new LineBreak()); }
                if (pieces[p].Length == 0) { continue; }

                var element = new Run(pieces[p]) { Foreground = run.Code == 1 ? ink : ink };
                if (run.Bold == 1) { element.FontWeight = FontWeights.SemiBold; }
                if (run.Italic == 1) { element.FontStyle = FontStyles.Italic; }
                if (run.Strike == 1) { element.TextDecorations = TextDecorations.Strikethrough; }
                if (run.Code == 1)
                {
                    element.FontFamily = Mono;
                    element.FontSize = fontSize * 0.92;
                    element.Background = CodeBg;
                }
                if (run.Link == 1)
                {
                    element.Foreground = LinkColor;
                    element.TextDecorations = TextDecorations.Underline;
                }
                block.Inlines.Add(element);
            }
        }
    }

    // ======================================================================
    //  小工具
    // ======================================================================

    private static FrameworkElement WithBottomGap(FrameworkElement element, double gap)
    {
        element.Margin = new Thickness(
            element.Margin.Left,
            element.Margin.Top,
            element.Margin.Right,
            element.Margin.Bottom + gap);
        return element;
    }

    private static Brush Freeze(string hex)
    {
        var brush = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;
        brush.Freeze();
        return brush;
    }
}
