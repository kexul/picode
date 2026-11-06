using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace PiChat;

/// <summary>
/// 把一条回复里的 markdown 画出来：段落、标题、列表、引用、代码块，加上行内的粗体 / 斜体 / 行内代码 / 链接。
///
/// 只做聊天里真会碰到的那几样，不是完整的 markdown（表格、脚注、HTML 那些不认）。
/// 网页端那边用 marked（见 media/chat.js 的 mdOptions：breaks 开着，所以单个换行就是换行），
/// 这里跟着那条走：一段里的换行照旧换行，空行才分段。
/// </summary>
internal static class Markdown
{
    private static readonly FontFamily Mono = new("Consolas, Cascadia Mono, Courier New");
    private static readonly Brush CodeBg = Freeze("#f1f2f4");
    private static readonly Brush CodeBorder = Freeze("#e2e4e8");
    private static readonly Brush LinkColor = Freeze("#1a5fb4");
    private static readonly Brush RuleColor = Freeze("#e5e7eb");

    /// <summary>画成一摞块（直接塞进气泡里）。</summary>
    public static FrameworkElement Render(string text, double fontSize, Brush ink, Brush subtle)
    {
        var panel = new StackPanel();
        var blocks = ParseBlocks(text ?? "");
        for (var i = 0; i < blocks.Count; i++)
        {
            var element = MakeBlock(blocks[i], fontSize, ink, subtle);
            if (i < blocks.Count - 1) { element = WithBottomGap(element, fontSize * 0.65); }
            panel.Children.Add(element);
        }
        return panel;
    }

    // ======================================================================
    //  块：先切成一段一段的
    // ======================================================================

    private abstract record Block;
    private sealed record ParagraphBlock(string Text) : Block;
    private sealed record HeadingBlock(int Level, string Text) : Block;
    /// <summary>列表里的一项：Marker 是「•」或者「3.」。</summary>
    private sealed record Item(string Marker, string Text);
    private sealed record ListBlock(bool Ordered, List<Item> Items) : Block;
    private sealed record CodeBlock(string Text) : Block;
    private sealed record QuoteBlock(string Text) : Block;
    private sealed record RuleBlock : Block;

    private static List<Block> ParseBlocks(string text)
    {
        var blocks = new List<Block>();
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var i = 0;
        while (i < lines.Length)
        {
            var raw = lines[i];
            var line = raw.Trim();
            if (line.Length == 0) { i++; continue; }

            // 代码块：``` 或者 ~~~ 开头，一直到同一种栅栏收尾（后面跟着的语言名不管）
            if (line.StartsWith("```", StringComparison.Ordinal) || line.StartsWith("~~~", StringComparison.Ordinal))
            {
                var fence = line[..3];
                var code = new StringBuilder();
                i++;
                while (i < lines.Length && !lines[i].TrimStart().StartsWith(fence, StringComparison.Ordinal))
                {
                    code.Append(lines[i]).Append('\n');
                    i++;
                }
                if (i < lines.Length) { i++; }        // 收尾的那一行
                blocks.Add(new CodeBlock(code.ToString().TrimEnd('\n')));
                continue;
            }

            // 一条横线
            if (IsRule(line)) { blocks.Add(new RuleBlock()); i++; continue; }

            // 标题：# 到 ######，后面得有个空格
            var hashes = 0;
            while (hashes < line.Length && line[hashes] == '#') { hashes++; }
            if (hashes is >= 1 and <= 6 && line.Length > hashes && line[hashes] == ' ')
            {
                blocks.Add(new HeadingBlock(hashes, line[(hashes + 1)..].Trim()));
                i++;
                continue;
            }

            // 引用：连着几行以 > 开头的合成一段
            if (line.StartsWith('>'))
            {
                var quote = new StringBuilder();
                while (i < lines.Length && lines[i].TrimStart().StartsWith('>'))
                {
                    var piece = lines[i].TrimStart()[1..];
                    if (piece.StartsWith(' ')) { piece = piece[1..]; }
                    if (quote.Length > 0) { quote.Append('\n'); }
                    quote.Append(piece);
                    i++;
                }
                blocks.Add(new QuoteBlock(quote.ToString().TrimEnd()));
                continue;
            }

            // 列表：连着几项，类型得一样（隔一个空行断了，就另起一截）
            if (TryItem(line, out var ordered, out var marker, out var first))
            {
                var items = new List<Item> { new(marker, first) };
                i++;
                while (i < lines.Length && TryItem(lines[i].Trim(), out var sameOrdered, out var nextMarker, out var nextText)
                    && sameOrdered == ordered)
                {
                    items.Add(new Item(nextMarker, nextText));
                    i++;
                }
                blocks.Add(new ListBlock(ordered, items));
                continue;
            }

            // 剩下的就是一段：一直到空行 / 下一个块的开头
            var paragraph = new StringBuilder(raw.TrimEnd());
            i++;
            while (i < lines.Length && IsParagraphLine(lines[i]))
            {
                paragraph.Append('\n').Append(lines[i].TrimEnd());
                i++;
            }
            blocks.Add(new ParagraphBlock(paragraph.ToString()));
        }
        return blocks;
    }

    private static bool IsParagraphLine(string raw)
    {
        var line = raw.Trim();
        if (line.Length == 0) { return false; }
        if (line.StartsWith("```", StringComparison.Ordinal) || line.StartsWith("~~~", StringComparison.Ordinal)) { return false; }
        if (IsRule(line)) { return false; }
        if (line.StartsWith('>')) { return false; }
        if (TryItem(line, out _, out _, out _)) { return false; }
        var hashes = 0;
        while (hashes < line.Length && line[hashes] == '#') { hashes++; }
        return !(hashes is >= 1 and <= 6 && line.Length > hashes && line[hashes] == ' ');
    }

    private static bool IsRule(string line)
    {
        if (line.Length < 3) { return false; }
        foreach (var c in line)
        {
            if (c is not ('-' or '*' or '_')) { return false; }
        }
        var first = line[0];
        foreach (var c in line) { if (c != first) { return false; } }
        return true;
    }

    /// <summary>这一行是不是列表项（`- x`、`* x`、`1. x`、`1) x`）。</summary>
    private static bool TryItem(string line, out bool ordered, out string marker, out string text)
    {
        ordered = false;
        marker = "";
        text = "";
        if (line.Length < 2) { return false; }

        if (line[0] is '-' or '*' or '+')
        {
            if (line.Length < 2 || line[1] != ' ') { return false; }
            marker = "•";
            text = line[2..].Trim();
            return text.Length > 0;
        }

        var digits = 0;
        while (digits < line.Length && char.IsAsciiDigit(line[digits])) { digits++; }
        if (digits == 0 || digits > 3) { return false; }
        if (digits + 1 >= line.Length) { return false; }
        var sep = line[digits];
        if (sep != '.' && sep != ')') { return false; }
        if (line[digits + 1] != ' ') { return false; }
        ordered = true;
        marker = line[..digits] + ".";
        text = line[(digits + 2)..].Trim();
        return text.Length > 0;
    }

    // ======================================================================
    //  块 → 控件
    // ======================================================================

    private static FrameworkElement MakeBlock(Block block, double fontSize, Brush ink, Brush subtle)
    {
        switch (block)
        {
            case ParagraphBlock p:
            {
                var text = TextBlockOf(p.Text, fontSize, ink);
                text.LineHeight = fontSize * 1.65;
                return text;
            }

            case HeadingBlock h:
            {
                var size = h.Level switch { 1 => 1.45, 2 => 1.3, 3 => 1.15, _ => 1.05 };
                var text = TextBlockOf(h.Text, fontSize * size, ink, bold: true);
                text.Margin = new Thickness(0, h.Level <= 2 ? fontSize * 0.35 : 0, 0, 0);
                return text;
            }

            case ListBlock list:
            {
                var panel = new StackPanel();
                foreach (var item in list.Items)
                {
                    var row = new Grid { Margin = new Thickness(0, 0, 0, fontSize * 0.25) };
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    var bullet = new TextBlock
                    {
                        Text = item.Marker,
                        FontSize = fontSize,
                        Foreground = subtle,
                        Margin = new Thickness(list.Ordered ? 2 : 4, 0, 8, 0),
                        VerticalAlignment = VerticalAlignment.Top,
                    };
                    Grid.SetColumn(bullet, 0);
                    var body = TextBlockOf(item.Text, fontSize, ink);
                    body.LineHeight = fontSize * 1.65;
                    Grid.SetColumn(body, 1);
                    row.Children.Add(bullet);
                    row.Children.Add(body);
                    panel.Children.Add(row);
                }
                panel.Margin = new Thickness(4, 0, 0, 0);
                return panel;
            }

            case CodeBlock code:
            {
                // 只读的 TextBox：能选、能复制，横向能滚（长命令 / 长路径不会被折断）
                var box = new TextBox
                {
                    Text = code.Text,
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

            case QuoteBlock quote:
            {
                return new Border
                {
                    Background = CodeBg,
                    BorderBrush = RuleColor,
                    BorderThickness = new Thickness(3, 0, 0, 0),
                    Padding = new Thickness(10, 6, 8, 6),
                    Child = TextBlockOf(quote.Text, fontSize, subtle),
                };
            }

            case RuleBlock:
                return new Border
                {
                    Height = 1,
                    Background = RuleColor,
                    Margin = new Thickness(0, 2, 0, 2),
                };

            default:
                return new TextBlock { Text = "", FontSize = fontSize };
        }
    }

    private static TextBlock TextBlockOf(string text, double fontSize, Brush ink, bool bold = false)
    {
        var block = new TextBlock
        {
            FontSize = fontSize,
            Foreground = ink,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = fontSize * 1.6,
        };
        if (bold) { block.FontWeight = FontWeights.SemiBold; }
        AddInlines(block, text, fontSize, ink, bold);
        return block;
    }

    // ======================================================================
    //  行内的那几样：`代码` **粗** *斜* ~~删掉~~ [链接](地址)
    // ======================================================================

    private static void AddInlines(TextBlock block, string text, double fontSize, Brush ink, bool bold)
    {
        var buffer = new StringBuilder();

        void Flush()
        {
            if (buffer.Length == 0) { return; }
            block.Inlines.Add(new Run(buffer.ToString()) { Foreground = ink });
            buffer.Clear();
        }

        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];

            if (c == '\n')
            {
                Flush();
                block.Inlines.Add(new LineBreak());
                i++;
                continue;
            }

            // 行内代码：`这样`
            if (c == '`')
            {
                var end = text.IndexOf('`', i + 1);
                if (end > i + 1)
                {
                    Flush();
                    block.Inlines.Add(new Run(text[(i + 1)..end])
                    {
                        FontFamily = Mono,
                        FontSize = fontSize * 0.92,
                        Background = CodeBg,
                    });
                    i = end + 1;
                    continue;
                }
            }

            // 链接：[这几个字](这个地址) —— 只显示那几个字，点不开（要跳就去浏览器里看）
            if (c == '[')
            {
                var close = text.IndexOf(']', i + 1);
                if (close > i + 1 && close + 1 < text.Length && text[close + 1] == '(')
                {
                    var end = text.IndexOf(')', close + 2);
                    if (end > close + 1)
                    {
                        Flush();
                        block.Inlines.Add(new Run(text[(i + 1)..close])
                        {
                            Foreground = LinkColor,
                            TextDecorations = TextDecorations.Underline,
                        });
                        i = end + 1;
                        continue;
                    }
                }
            }

            // 成对的记号：先试两个字的（** __ ~~），再试一个字的（* _）
            if (TryWrap(text, i, "**", out var strong) || TryWrap(text, i, "__", out strong))
            {
                Flush();
                var run = new Run(strong) { Foreground = ink, FontWeight = FontWeights.SemiBold };
                block.Inlines.Add(run);
                i += strong.Length + 4;
                continue;
            }
            if (TryWrap(text, i, "~~", out var struck))
            {
                Flush();
                block.Inlines.Add(new Run(struck) { Foreground = ink, TextDecorations = TextDecorations.Strikethrough });
                i += struck.Length + 4;
                continue;
            }
            if (TryWrap(text, i, "*", out var em) || TryWrap(text, i, "_", out em))
            {
                Flush();
                block.Inlines.Add(new Run(em) { Foreground = ink, FontStyle = FontStyles.Italic });
                i += em.Length + 2;
                continue;
            }

            buffer.Append(c);
            i++;
        }
        Flush();
    }

    /// <summary>
    /// 从 i 开始是不是夹着一对 marker（内容不能空、不能以空格开头或结尾：
    /// 这样 `a * b`、`文件名_x` 这类就不会被当成强调）。
    /// </summary>
    private static bool TryWrap(string text, int start, string marker, out string inner)
    {
        inner = "";
        if (start + marker.Length >= text.Length) { return false; }
        if (string.CompareOrdinal(text, start, marker, 0, marker.Length) != 0) { return false; }
        var from = start + marker.Length;
        if (char.IsWhiteSpace(text[from])) { return false; }
        var end = text.IndexOf(marker, from, StringComparison.Ordinal);
        if (end <= from) { return false; }
        if (char.IsWhiteSpace(text[end - 1])) { return false; }
        // 单字形的 *_ 不要在词中间动手（snake_case、2*3）
        if (marker.Length == 1 && start > 0 && (char.IsLetterOrDigit(text[start - 1]) || text[start - 1] == '_'))
        {
            return false;
        }
        // 两个字的记号里面不该再出现它自己（**a **b** c** 这种）
        inner = text[from..end];
        if (marker.Length == 2 && inner.Contains(marker, StringComparison.Ordinal)) { return false; }
        return true;
    }

    // ======================================================================
    //  小工具
    // ======================================================================

    /// <summary>一行里把 markdown 的记号去掉（列表预览用）：代码块只留第一行、不掉字。</summary>
    public static string PlainOneLine(string text)
    {
        var line = (text ?? "").Replace("\r", "");
        // 代码块的栅栏与它里面那几行：只拿第一行内容
        if (line.StartsWith("```", StringComparison.Ordinal) || line.StartsWith("~~~", StringComparison.Ordinal))
        {
            var rest = line[3..].Trim();
            return rest.Length > 0 ? rest : "代码";
        }
        line = line.Trim();
        var hashes = 0;
        while (hashes < line.Length && line[hashes] == '#') { hashes++; }
        if (hashes is >= 1 and <= 6 && line.Length > hashes) { line = line[hashes..].Trim(); }
        if (line.StartsWith('>')) { line = line.TrimStart('>').Trim(); }
        if (TryItem(line, out _, out _, out var itemText)) { line = itemText; }
        line = line.Replace("**", "").Replace("__", "").Replace("~~", "").Replace("`", "");
        line = line.Replace("*", "").Replace("_", "");
        // [这几个字](地址) → 这几个字
        var open = line.IndexOf('[');
        while (open >= 0)
        {
            var close = line.IndexOf(']', open + 1);
            if (close < 0) { break; }
            var end = close + 1 < line.Length && line[close + 1] == '(' ? line.IndexOf(')', close + 2) : -1;
            if (end < 0) { break; }
            line = line[..open] + line[(open + 1)..close] + line[(end + 1)..];
            open = line.IndexOf('[', open);
        }
        return line.Trim();
    }

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
