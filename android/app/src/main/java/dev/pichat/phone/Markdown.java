package dev.pichat.phone;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.UnderlineSpan;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TableLayout;
import android.widget.TableRow;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 把一条回复里的 markdown 画出来：段落、标题、列表、引用、代码块，加上行内的粗体 / 斜体 / 行内代码 / 链接。
 *
 * 只做聊天里真会碰到的那几样，不是完整的 markdown（表格、脚注、HTML 那些不认）。
 * 跟网页端（media/chat.js 的 mdOptions：breaks 开着，单个换行就是换行）和桌面那个小窗口
 * （desktop/PiChat/Markdown.cs）走同一套规矩：一段里的换行照旧换行，空行才分段。
 */
final class Markdown {
    private static final int CODE_BG = 0xFFF1F2F4;
    private static final int CODE_BORDER = 0xFFE2E4E8;
    private static final int LINK = 0xFF1A5FB4;
    private static final int RULE = 0xFFE0E0E0;

    private Markdown() { }

    /** 把一条正文画成一摞控件，塞进 host 里。 */
    static void render(Context ctx, LinearLayout host, String text, float size, int ink, int subtle) {
        List<Object> blocks = parse(text == null ? "" : text);
        for (int i = 0; i < blocks.size(); i++) {
            View view = make(ctx, blocks.get(i), size, ink, subtle);
            if (i < blocks.size() - 1) {
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.bottomMargin = Math.round(size * 0.65f);
                view.setLayoutParams(lp);
            }
            host.addView(view);
        }
    }

    /** 列表那一行的一句话：把 markdown 的记号去掉（反引号、星号、井号、列表点）。 */
    static String plainOneLine(String text) {
        String line = text == null ? "" : text.replace("\r", "").trim();
        if (line.startsWith("```") || line.startsWith("~~~")) {
            String rest = line.substring(3).trim();
            return rest.isEmpty() ? "代码" : rest;
        }
        int hashes = 0;
        while (hashes < line.length() && line.charAt(hashes) == '#') { hashes++; }
        if (hashes >= 1 && hashes <= 6 && line.length() > hashes) { line = line.substring(hashes).trim(); }
        if (line.startsWith(">")) { line = line.substring(1).trim(); }
        Item item = itemOf(line);
        if (item != null) { line = item.text; }
        line = line.replace("**", "").replace("__", "").replace("~~", "")
            .replace("`", "").replace("*", "").replace("_", "");
        // [这几个字](地址) → 这几个字
        int open = line.indexOf('[');
        while (open >= 0) {
            int close = line.indexOf(']', open + 1);
            if (close < 0) { break; }
            int end = close + 1 < line.length() && line.charAt(close + 1) == '('
                ? line.indexOf(')', close + 2) : -1;
            if (end < 0) { break; }
            line = line.substring(0, open) + line.substring(open + 1, close) + line.substring(end + 1);
            open = line.indexOf('[', open);
        }
        return line.trim();
    }

    // ======================================================================
    //  块：先切成一段一段的
    // ======================================================================

    private static final class Paragraph { final String text; Paragraph(String t) { text = t; } }
    private static final class Heading { final int level; final String text; Heading(int l, String t) { level = l; text = t; } }
    private static final class Item { final String marker; final String text; Item(String m, String t) { marker = m; text = t; } }
    private static final class ListBlock { final boolean ordered; final List<Item> items; ListBlock(boolean o, List<Item> i) { ordered = o; items = i; } }
    private static final class Code { final String text; Code(String t) { text = t; } }
    private static final class Quote { final String text; Quote(String t) { text = t; } }
    private static final class Rule { }

    /** 一张表格：对齐（0 左 / 1 中 / 2 右），rows.get(0) 是表头。 */
    private static final class Table {
        final List<Integer> align;
        final List<List<String>> rows;
        Table(List<Integer> a, List<List<String>> r) { align = a; rows = r; }
    }

    private static List<Object> parse(String text) {
        List<Object> blocks = new ArrayList<>();
        String[] lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        int i = 0;
        while (i < lines.length) {
            String raw = lines[i];
            String line = raw.trim();
            if (line.isEmpty()) { i++; continue; }

            // 代码块：``` 或者 ~~~ 开头，一直到同一种栅栏收尾（后面跟着的语言名不管）
            if (line.startsWith("```") || line.startsWith("~~~")) {
                String fence = line.substring(0, 3);
                StringBuilder code = new StringBuilder();
                i++;
                while (i < lines.length && !lines[i].trim().startsWith(fence)) {
                    code.append(lines[i]).append('\n');
                    i++;
                }
                if (i < lines.length) { i++; }              // 收尾的那一行
                String body = code.toString();
                if (body.endsWith("\n")) { body = body.substring(0, body.length() - 1); }
                blocks.add(new Code(body));
                continue;
            }

            if (isRule(line)) { blocks.add(new Rule()); i++; continue; }

            // 标题：# 到 ######，后面得有个空格
            int hashes = 0;
            while (hashes < line.length() && line.charAt(hashes) == '#') { hashes++; }
            if (hashes >= 1 && hashes <= 6 && line.length() > hashes && line.charAt(hashes) == ' ') {
                blocks.add(new Heading(hashes, line.substring(hashes + 1).trim()));
                i++;
                continue;
            }

            // 引用：连着几行以 > 开头的合成一段
            if (line.startsWith(">")) {
                StringBuilder quote = new StringBuilder();
                while (i < lines.length && lines[i].trim().startsWith(">")) {
                    String piece = lines[i].trim().substring(1);
                    if (piece.startsWith(" ")) { piece = piece.substring(1); }
                    if (quote.length() > 0) { quote.append('\n'); }
                    quote.append(piece);
                    i++;
                }
                blocks.add(new Quote(quote.toString().trim()));
                continue;
            }

            // 列表：连着几项，类型得一样
            Item first = itemOf(line);
            if (first != null) {
                boolean ordered = Character.isDigit(line.charAt(0));
                List<Item> items = new ArrayList<>();
                items.add(first);
                i++;
                while (i < lines.length) {
                    String next = lines[i].trim();
                    Item item = itemOf(next);
                    if (item == null || Character.isDigit(next.charAt(0)) != ordered) { break; }
                    items.add(item);
                    i++;
                }
                blocks.add(new ListBlock(ordered, items));
                continue;
            }

            // 表格：这一行有竖线、下一行是「|---|---|」那种分隔行
            if (line.contains("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
                List<String> ruleCells = splitRow(lines[i + 1]);
                List<Integer> align = new ArrayList<>();
                for (String cell : ruleCells) { align.add(alignOf(cell)); }
                List<List<String>> rows = new ArrayList<>();
                rows.add(splitRow(line));
                i += 2;
                while (i < lines.length && !lines[i].trim().isEmpty() && lines[i].contains("|")) {
                    rows.add(splitRow(lines[i].trim()));
                    i++;
                }
                // 每行补到列数一样（写 markdown 的人常常少写几格）
                for (List<String> row : rows) {
                    while (row.size() < align.size()) { row.add(""); }
                }
                blocks.add(new Table(align, rows));
                continue;
            }

            // 剩下的就是一段：一直到空行 / 下一个块的开头
            StringBuilder paragraph = new StringBuilder(trimEnd(raw));
            i++;
            while (i < lines.length && isParagraphLine(lines[i])) {
                paragraph.append('\n').append(trimEnd(lines[i]));
                i++;
            }
            blocks.add(new Paragraph(paragraph.toString()));
        }
        return blocks;
    }

    private static boolean isParagraphLine(String raw) {
        String line = raw.trim();
        if (line.isEmpty()) { return false; }
        if (line.startsWith("```") || line.startsWith("~~~")) { return false; }
        if (isRule(line)) { return false; }
        if (line.startsWith(">")) { return false; }
        if (itemOf(line) != null) { return false; }
        if (line.startsWith("|")) { return false; }
        int hashes = 0;
        while (hashes < line.length() && line.charAt(hashes) == '#') { hashes++; }
        return !(hashes >= 1 && hashes <= 6 && line.length() > hashes && line.charAt(hashes) == ' ');
    }

    private static boolean isRule(String line) {
        if (line.length() < 3) { return false; }
        char first = line.charAt(0);
        if (first != '-' && first != '*' && first != '_') { return false; }
        for (int i = 0; i < line.length(); i++) {
            if (line.charAt(i) != first) { return false; }
        }
        return true;
    }

    /** `|---|---:|:---:|` 这种分隔行：决定每一列对齐，也用它认出「这是表格」。 */
    private static boolean isTableRule(String raw) {
        List<String> cells = splitRow(raw.trim());
        if (cells.isEmpty()) { return false; }
        for (String cell : cells) {
            String text = cell.trim();
            if (text.isEmpty()) { return false; }
            String dashes = text.replace(":", "");
            if (dashes.isEmpty()) { return false; }
            for (int i = 0; i < dashes.length(); i++) {
                if (dashes.charAt(i) != '-') { return false; }
            }
        }
        return true;
    }

    /** 对齐：0 左 / 1 中 / 2 右（看分隔行那一格两头有没有冒号）。 */
    private static int alignOf(String cell) {
        String text = cell.trim();
        boolean left = text.startsWith(":");
        boolean right = text.endsWith(":");
        if (left && right) { return 1; }
        return right ? 2 : 0;
    }

    /** 把一行竖线格切成几格（去掉两头的竖线，`\|` 当普通的竖线）。 */
    private static List<String> splitRow(String raw) {
        String line = raw.trim();
        if (line.startsWith("|")) { line = line.substring(1); }
        if (line.endsWith("|") && !line.endsWith("\\|")) { line = line.substring(0, line.length() - 1); }
        List<String> cells = new ArrayList<>();
        StringBuilder buffer = new StringBuilder();
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (ch == '\\' && i + 1 < line.length() && line.charAt(i + 1) == '|') {
                buffer.append('|');
                i++;
                continue;
            }
            if (ch == '|') {
                cells.add(buffer.toString().trim());
                buffer.setLength(0);
                continue;
            }
            buffer.append(ch);
        }
        cells.add(buffer.toString().trim());
        return cells;
    }

    /** 这一行是不是列表项（`- x`、`* x`、`1. x`、`1) x`）。 */
    private static Item itemOf(String line) {
        if (line.length() < 2) { return null; }

        char c = line.charAt(0);
        if (c == '-' || c == '*' || c == '+') {
            if (line.charAt(1) != ' ') { return null; }
            String text = line.substring(2).trim();
            return text.isEmpty() ? null : new Item("•", text);
        }

        int digits = 0;
        while (digits < line.length() && Character.isDigit(line.charAt(digits))) { digits++; }
        if (digits == 0 || digits > 3 || digits + 1 >= line.length()) { return null; }
        char sep = line.charAt(digits);
        if (sep != '.' && sep != ')') { return null; }
        if (line.charAt(digits + 1) != ' ') { return null; }
        String text = line.substring(digits + 2).trim();
        return text.isEmpty() ? null : new Item(line.substring(0, digits) + ".", text);
    }

    private static String trimEnd(String text) {
        int end = text.length();
        while (end > 0 && Character.isWhitespace(text.charAt(end - 1))) { end--; }
        return text.substring(0, end);
    }

    // ======================================================================
    //  块 → 控件
    // ======================================================================

    private static View make(Context ctx, Object block, float size, int ink, int subtle) {
        if (block instanceof Paragraph) {
            TextView view = textView(ctx, ((Paragraph) block).text, size, ink, false);
            view.setLineSpacing(0, 1.15f);
            return view;
        }

        if (block instanceof Heading) {
            Heading h = (Heading) block;
            float mul = h.level == 1 ? 1.4f : h.level == 2 ? 1.25f : h.level == 3 ? 1.12f : 1.04f;
            TextView view = textView(ctx, h.text, size * mul, ink, true);
            view.setPadding(0, h.level <= 2 ? Math.round(size * 0.35f) : 0, 0, 0);
            return view;
        }

        if (block instanceof ListBlock) {
            ListBlock list = (ListBlock) block;
            LinearLayout panel = new LinearLayout(ctx);
            panel.setOrientation(LinearLayout.VERTICAL);
            for (Item item : list.items) {
                LinearLayout row = new LinearLayout(ctx);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setPadding(Math.round(size * 0.35f), 0, 0, Math.round(size * 0.25f));

                TextView bullet = new TextView(ctx);
                bullet.setText(item.marker);
                bullet.setTextSize(size);
                bullet.setTextColor(subtle);
                bullet.setPadding(0, 0, Math.round(size * 0.55f), 0);
                row.addView(bullet, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

                TextView body = textView(ctx, item.text, size, ink, false);
                body.setLineSpacing(0, 1.15f);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                row.addView(body, lp);
                panel.addView(row);
            }
            return panel;
        }

        if (block instanceof Code) {
            TextView code = new TextView(ctx);
            code.setText(((Code) block).text);
            code.setTextSize(size - 2 >= 10 ? size - 2 : 10);
            code.setTextColor(ink);
            code.setTypeface(Typeface.MONOSPACE);
            code.setTextIsSelectable(true);
            code.setHorizontallyScrolling(true);
            code.setPadding(dp(ctx, 10), dp(ctx, 8), dp(ctx, 10), dp(ctx, 8));

            // 长命令、长路径不折断：横着能滑
            HorizontalScrollView scroll = new HorizontalScrollView(ctx);
            scroll.setHorizontalScrollBarEnabled(true);
            scroll.addView(code);

            android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
            background.setColor(CODE_BG);
            background.setCornerRadius(dp(ctx, 6));
            background.setStroke(dp(ctx, 1), CODE_BORDER);
            scroll.setBackground(background);
            return scroll;
        }

        if (block instanceof Quote) {
            TextView view = textView(ctx, ((Quote) block).text, size, subtle, false);
            view.setLineSpacing(0, 1.15f);
            view.setPadding(dp(ctx, 10), dp(ctx, 6), dp(ctx, 8), dp(ctx, 6));

            android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
            background.setColor(CODE_BG);
            background.setCornerRadius(dp(ctx, 4));
            view.setBackground(background);

            // 左边那一条竖线：用一层左边框的 shape 叠着画不出来，就塞进一个横排里
            LinearLayout wrapper = new LinearLayout(ctx);
            wrapper.setOrientation(LinearLayout.HORIZONTAL);
            View bar = new View(ctx);
            bar.setBackgroundColor(RULE);
            wrapper.addView(bar, new LinearLayout.LayoutParams(dp(ctx, 3), ViewGroup.LayoutParams.MATCH_PARENT));
            wrapper.addView(view, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            return wrapper;
        }

        if (block instanceof Table) {
            Table table = (Table) block;
            // TableLayout 自己会把同一列撑成一样宽，天生对齐
            TableLayout layout = new TableLayout(ctx);
            layout.setStretchAllColumns(false);
            layout.setShrinkAllColumns(false);
            for (int r = 0; r < table.rows.size(); r++) {
                TableRow row = new TableRow(ctx);
                List<String> cells = table.rows.get(r);
                for (int c = 0; c < table.align.size(); c++) {
                    String text = c < cells.size() ? cells.get(c) : "";
                    TextView cell = textView(ctx, text, size - 1, ink, r == 0);
                    cell.setSingleLine(true);
                    cell.setPadding(dp(ctx, 8), dp(ctx, 5), dp(ctx, 8), dp(ctx, 5));
                    int a = table.align.get(c);
                    cell.setGravity(a == 1 ? android.view.Gravity.CENTER : a == 2 ? android.view.Gravity.END : android.view.Gravity.START);
                    if (r == 0) { cell.setBackgroundColor(CODE_BG); }
                    row.addView(cell, new TableRow.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                }
                layout.addView(row, new TableLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            }
            // 列一多就横向滑（挤窄了反而看不清）
            HorizontalScrollView scroll = new HorizontalScrollView(ctx);
            scroll.setHorizontalScrollBarEnabled(true);
            scroll.addView(layout);
            return scroll;
        }

        if (block instanceof Rule) {
            // 一条横线：外面套一层给上下留白（直接给那条线塞 padding 会被撑成一大块）
            LinearLayout wrapper = new LinearLayout(ctx);
            wrapper.setOrientation(LinearLayout.VERTICAL);
            wrapper.setPadding(0, dp(ctx, 6), 0, dp(ctx, 6));
            View line = new View(ctx);
            line.setBackgroundColor(RULE);
            wrapper.addView(line, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(ctx, 1))));
            return wrapper;
        }

        return new View(ctx);
    }

    private static TextView textView(Context ctx, String text, float size, int color, boolean bold) {
        TextView view = new TextView(ctx);
        view.setTextSize(size > 0 ? size : 15);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.15f);
        view.setTextIsSelectable(true);
        SpannableStringBuilder span = new SpannableStringBuilder();
        addInline(span, text, color, bold);
        view.setText(span);
        return view;
    }

    // ======================================================================
    //  行内的那几样：`代码` **粗** *斜* ~~删掉~~ [链接](地址)
    // ======================================================================

    private static void addInline(SpannableStringBuilder out, String text, int ink, boolean bold) {
        int i = 0;
        StringBuilder buffer = new StringBuilder();

        while (i < text.length()) {
            char c = text.charAt(i);

            if (c == '\n') {
                flush(out, buffer, ink, bold, 0);
                out.append('\n');
                i++;
                continue;
            }

            // 行内代码：`这样`
            if (c == '`') {
                int end = text.indexOf('`', i + 1);
                if (end > i + 1) {
                    flush(out, buffer, ink, bold, 0);
                    int start = out.length();
                    out.append(text, i + 1, end);
                    out.setSpan(new TypefaceSpan("monospace"), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new BackgroundColorSpan(CODE_BG), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = end + 1;
                    continue;
                }
            }

            // 链接：[这几个字](这个地址) —— 只显示那几个字，点不开（要跳就去浏览器里看）
            if (c == '[') {
                int close = text.indexOf(']', i + 1);
                if (close > i + 1 && close + 1 < text.length() && text.charAt(close + 1) == '(') {
                    int end = text.indexOf(')', close + 2);
                    if (end > close + 1) {
                        flush(out, buffer, ink, bold, 0);
                        int start = out.length();
                        out.append(text, i + 1, close);
                        out.setSpan(new ForegroundColorSpan(LINK), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new UnderlineSpan(), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                        i = end + 1;
                        continue;
                    }
                }
            }

            // 成对的记号：先试两个字的（** __ ~~），再试一个字的（* _）
            String strong = wrap(text, i, "**");
            if (strong == null) { strong = wrap(text, i, "__"); }
            if (strong != null) {
                flush(out, buffer, ink, bold, 0);
                int start = out.length();
                out.append(strong);
                out.setSpan(new StyleSpan(bold ? Typeface.BOLD_ITALIC : Typeface.BOLD), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                i += strong.length() + 4;
                continue;
            }

            String struck = wrap(text, i, "~~");
            if (struck != null) {
                flush(out, buffer, ink, bold, 0);
                int start = out.length();
                out.append(struck);
                out.setSpan(new StrikethroughSpan(), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                i += struck.length() + 4;
                continue;
            }

            String em = wrap(text, i, "*");
            if (em == null) { em = wrap(text, i, "_"); }
            if (em != null) {
                flush(out, buffer, ink, bold, 0);
                int start = out.length();
                out.append(em);
                out.setSpan(new StyleSpan(bold ? Typeface.BOLD_ITALIC : Typeface.ITALIC), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                i += em.length() + 2;
                continue;
            }

            buffer.append(c);
            i++;
        }
        flush(out, buffer, ink, bold, 0);
    }

    private static void flush(SpannableStringBuilder out, StringBuilder buffer, int ink, boolean bold, int unused) {
        if (buffer.length() == 0) { return; }
        int start = out.length();
        out.append(buffer);
        if (bold) { out.setSpan(new StyleSpan(Typeface.BOLD), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); }
        buffer.setLength(0);
    }

    /**
     * 从 start 开始是不是夹着一对 marker（内容不能空、不能以空格开头或结尾：
     * 这样 `a * b`、`文件名_x` 这类就不会被当成强调）。
     */
    private static String wrap(String text, int start, String marker) {
        int from = start + marker.length();
        if (from >= text.length()) { return null; }
        if (!text.startsWith(marker, start)) { return null; }
        if (Character.isWhitespace(text.charAt(from))) { return null; }
        int end = text.indexOf(marker, from);
        if (end <= from) { return null; }
        if (Character.isWhitespace(text.charAt(end - 1))) { return null; }
        if (marker.length() == 1 && start > 0) {
            char before = text.charAt(start - 1);
            if (Character.isLetterOrDigit(before) || before == '_') { return null; }
        }
        String inner = text.substring(from, end);
        if (marker.length() == 2 && inner.contains(marker)) { return null; }
        return inner;
    }

    private static int dp(Context ctx, int value) {
        return Math.round(value * ctx.getResources().getDisplayMetrics().density);
    }
}
