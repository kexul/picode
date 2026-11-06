package dev.pichat.phone;

import android.content.Context;
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

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 把一条回复画出来：段落、标题、列表、表格、引用、代码块、分隔线，加上行内的粗体 / 斜体 /
 * 删除线 / 行内代码 / 链接文字。
 *
 * **解析不在手机上**：后端推过来的每条通知里已经带好一份「怎么画」的结构
 * （见仓库里的 src/markdownBlocks.ts），这里只照着画。桌面那个小程序也是这么干的 ——
 * 同一段字在两边画得一样，加新东西只用改后端。
 * 老后端推来的没有这份结构（或者自己刚发出去的那句还没回来），那就把整段文字当一段画。
 */
final class Markdown {
    private static final int CODE_BG = 0xFFF1F2F4;
    private static final int LINK = 0xFF1A5FB4;
    private static final int RULE = 0xFFE0E0E0;

    private Markdown() { }

    /**
     * 把一条正文画成一摞控件，塞进 host 里。
     *
     * @param blocks       后端解析好的结构（可能是 null：老后端 / 自己刚发的那句）
     * @param fallbackText 没有结构时拿它当一段话
     */
    static void render(Context ctx, LinearLayout host, JSONArray blocks, String fallbackText, float size, int ink, int subtle) {
        if (blocks == null || blocks.length() == 0) {
            TextView text = textView(ctx, plainRuns(fallbackText), size, ink, false);
            host.addView(text);
            return;
        }

        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.optJSONObject(i);
            if (block == null) { continue; }
            View view = make(ctx, block, size, ink, subtle);
            if (i < blocks.length() - 1) {
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.bottomMargin = Math.round(size * 0.65f);
                view.setLayoutParams(lp);
            }
            host.addView(view);
        }
    }

    /** 没有结构时：把整段文字当成一截「普通字」（换行照旧换行）。 */
    private static JSONArray plainRuns(String text) {
        JSONArray runs = new JSONArray();
        if (text == null || text.isEmpty()) { return runs; }
        JSONObject run = new JSONObject();
        try {
            run.put("v", text);
            runs.put(run);
        } catch (Exception ignored) {
            // 放不进去就当没有
        }
        return runs;
    }

    // ======================================================================
    //  块 → 控件
    // ======================================================================

    private static View make(Context ctx, JSONObject block, float size, int ink, int subtle) {
        String kind = block.optString("k", "");

        if ("p".equals(kind)) {
            TextView view = textView(ctx, block.optJSONArray("r"), size, ink, false);
            view.setLineSpacing(0, 1.15f);
            return view;
        }

        if ("h".equals(kind)) {
            int level = Math.max(1, Math.min(6, block.optInt("n", 1)));
            float mul = level == 1 ? 1.4f : level == 2 ? 1.25f : level == 3 ? 1.12f : 1.04f;
            TextView view = textView(ctx, block.optJSONArray("r"), size * mul, ink, true);
            view.setPadding(0, level <= 2 ? Math.round(size * 0.35f) : 0, 0, 0);
            return view;
        }

        if ("l".equals(kind)) {
            boolean ordered = block.optBoolean("o", false);
            LinearLayout panel = new LinearLayout(ctx);
            panel.setOrientation(LinearLayout.VERTICAL);
            JSONArray items = block.optJSONArray("i");
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    if (item == null) { continue; }
                    LinearLayout row = new LinearLayout(ctx);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    row.setPadding(Math.round(size * 0.35f), 0, 0, Math.round(size * 0.25f));

                    TextView bullet = new TextView(ctx);
                    bullet.setText(item.optString("m", "•"));
                    bullet.setTextSize(size);
                    bullet.setTextColor(subtle);
                    bullet.setPadding(0, 0, Math.round(size * 0.55f), 0);
                    row.addView(bullet, new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

                    TextView body = textView(ctx, item.optJSONArray("r"), size, ink, false);
                    body.setLineSpacing(0, 1.15f);
                    row.addView(body, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                    panel.addView(row);
                }
            }
            if (ordered) { panel.setPadding(Math.round(size * 0.1f), 0, 0, 0); }
            return panel;
        }

        if ("code".equals(kind)) {
            TextView code = new TextView(ctx);
            code.setText(block.optString("v", ""));
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
            background.setStroke(dp(ctx, 1), 0xFFE2E4E8);
            scroll.setBackground(background);
            return scroll;
        }

        if ("q".equals(kind)) {
            TextView view = textView(ctx, block.optJSONArray("r"), size, subtle, false);
            view.setLineSpacing(0, 1.15f);
            view.setPadding(dp(ctx, 10), dp(ctx, 6), dp(ctx, 8), dp(ctx, 6));

            android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
            background.setColor(CODE_BG);
            background.setCornerRadius(dp(ctx, 4));
            view.setBackground(background);

            // 左边那一条竖线
            LinearLayout wrapper = new LinearLayout(ctx);
            wrapper.setOrientation(LinearLayout.HORIZONTAL);
            View bar = new View(ctx);
            bar.setBackgroundColor(RULE);
            wrapper.addView(bar, new LinearLayout.LayoutParams(dp(ctx, 3), ViewGroup.LayoutParams.MATCH_PARENT));
            wrapper.addView(view, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            return wrapper;
        }

        if ("hr".equals(kind)) {
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

        if ("t".equals(kind)) {
            JSONArray align = block.optJSONArray("a");
            JSONArray rows = block.optJSONArray("g");
            // TableLayout 自己会把同一列撑成一样宽，天生对齐
            TableLayout layout = new TableLayout(ctx);
            layout.setStretchAllColumns(false);
            layout.setShrinkAllColumns(false);
            if (rows != null && align != null) {
                for (int r = 0; r < rows.length(); r++) {
                    JSONArray cells = rows.optJSONArray(r);
                    if (cells == null) { continue; }
                    TableRow row = new TableRow(ctx);
                    for (int c = 0; c < align.length(); c++) {
                        JSONArray runs = c < cells.length() ? cells.optJSONArray(c) : null;
                        TextView cell = textView(ctx, runs, size - 1, ink, r == 0);
                        cell.setSingleLine(true);
                        cell.setPadding(dp(ctx, 8), dp(ctx, 5), dp(ctx, 8), dp(ctx, 5));
                        int a = align.optInt(c, 0);
                        cell.setGravity(a == 1 ? android.view.Gravity.CENTER
                            : a == 2 ? android.view.Gravity.END : android.view.Gravity.START);
                        if (r == 0) { cell.setBackgroundColor(CODE_BG); }
                        row.addView(cell, new TableRow.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    }
                    layout.addView(row, new TableLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                }
            }
            // 列一多就横向滑（挤窄了反而看不清）
            HorizontalScrollView scroll = new HorizontalScrollView(ctx);
            scroll.setHorizontalScrollBarEnabled(true);
            scroll.addView(layout);
            return scroll;
        }

        return new View(ctx);
    }

    // ======================================================================
    //  行内：几截带样式的字 → 一个 TextView
    // ======================================================================

    private static TextView textView(Context ctx, JSONArray runs, float size, int color, boolean bold) {
        TextView view = new TextView(ctx);
        view.setTextSize(size > 0 ? size : 15);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.15f);
        view.setTextIsSelectable(true);

        SpannableStringBuilder out = new SpannableStringBuilder();
        if (runs != null) {
            for (int i = 0; i < runs.length(); i++) {
                JSONObject run = runs.optJSONObject(i);
                if (run == null) { continue; }
                String text = run.optString("v", "");
                if (text.isEmpty()) { continue; }

                boolean isBold = bold || run.optInt("b", 0) == 1;
                if (run.optInt("i", 0) == 1) { isBold = isBold; }

                int start = out.length();
                out.append(text);
                int end = out.length();

                if (isBold || run.optInt("i", 0) == 1) {
                    int style = isBold && run.optInt("i", 0) == 1 ? Typeface.BOLD_ITALIC
                        : isBold ? Typeface.BOLD : Typeface.ITALIC;
                    out.setSpan(new StyleSpan(style), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                }
                if (run.optInt("s", 0) == 1) {
                    out.setSpan(new StrikethroughSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                }
                if (run.optInt("c", 0) == 1) {
                    out.setSpan(new TypefaceSpan("monospace"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new BackgroundColorSpan(CODE_BG), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                }
                if (run.optInt("l", 0) == 1) {
                    out.setSpan(new ForegroundColorSpan(LINK), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new UnderlineSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                }
            }
        }
        view.setText(out);
        return view;
    }

    private static int dp(Context ctx, int value) {
        return Math.round(value * ctx.getResources().getDisplayMetrics().density);
    }
}
