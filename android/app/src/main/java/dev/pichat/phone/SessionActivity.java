package dev.pichat.phone;

import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 一个会话：进来先摆这儿已经有那几条，同时跟后端要一份对齐；之后这个会话来了新的就跟着加。
 *
 * 一条条竖着排，像聊天记录：跑完一轮说的话、模型问的题靠一边，自己说的靠另一边。
 * 问的那条底下画选项，点一下就答；底下能再回一句。别的机器推来的会话只能看，回不了。
 */
public class SessionActivity extends Activity {
    static final String EXTRA_SESSION = "sessionId";
    static final String EXTRA_NAME = "name";

    private String sessionId = "";
    private TextView title;
    private ScrollView scroller;
    private LinearLayout messages;
    private LinearLayout inputRow;
    private EditText input;
    private Button send;

    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 上一次画的是哪一份（没有新东西就不重画，正在输入的字不会被清掉）。 */
    private String drawn = "";
    /** 上一次画的时候有几条（只有来了新的一条才滚到最底下，答完题别把看的位置跳走）。 */
    private String notesKey = "";

    private final Runnable onChange = () -> {
        if (!isFinishing()) { render(); }
    };

    /** 页面开着就每 4 秒拉一次：「这一轮」那张卡片要跟着长出来（关掉就不拉了）。 */
    private final Runnable liveTick = new Runnable() {
        @Override
        public void run() {
            fetchDetail();
            ui.postDelayed(this, 4000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sessionId = getIntent().getStringExtra(EXTRA_SESSION);
        if (sessionId == null) { sessionId = ""; }
        setContentView(buildUi());
        String name = getIntent().getStringExtra(EXTRA_NAME);
        if (name != null && !name.isEmpty()) { title.setText(name); }
        Store.listen(onChange);
        render();
        fetchDetail();
    }

    private View buildUi() {
        int pad = dp(10);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // 顶上：返回 + 会话名
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(pad, pad, pad, pad);

        TextView back = new TextView(this);
        back.setText("‹ 返回");
        back.setTextSize(15);
        back.setTextColor(0xFF3A6EA5);
        back.setPadding(0, pad / 2, pad, pad / 2);
        back.setOnClickListener(v -> finish());
        top.addView(back);

        title = new TextView(this);
        title.setText("会话");
        title.setTextSize(17);
        title.setTextColor(0xFF1E1E1E);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tlp.leftMargin = pad;
        top.addView(title, tlp);
        root.addView(top);

        // 中间：一条条躺着，能上下滚
        scroller = new ScrollView(this);
        messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        messages.setPadding(pad, 0, pad, pad);
        scroller.addView(messages, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroller, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 底下：回一句
        inputRow = new LinearLayout(this);
        inputRow.setOrientation(LinearLayout.HORIZONTAL);
        inputRow.setGravity(Gravity.BOTTOM);
        inputRow.setPadding(pad, pad / 2, pad, pad);

        input = new EditText(this);
        input.setHint("回一句");
        input.setTextSize(15);
        input.setSingleLine(false);
        input.setMaxLines(4);
        inputRow.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        send = new Button(this);
        send.setText("发送");
        send.setAllCaps(false);
        send.setOnClickListener(v -> sendText());
        inputRow.addView(send);
        root.addView(inputRow);

        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        return root;
    }

    /** 把这一份会话画出来：几条、哪道题答过了、能不能回，都在这一遍里定。 */
    private void render() {
        if (isFinishing() || messages == null) { return; }

        Store.Session session = Store.session(sessionId);
        String header = "";
        if (session != null) {
            title.setText(session.name);
            // 别的机器推来的会话也能回：后端把这句话转回那台（见 webChatServer.ts 的 /phone/send）
            header = session.name + "|" + session.remote;
        }

        List<Store.Note> list = Store.notes(sessionId);
        int answeredCount = 0;
        for (Store.Note note : list) {
            if (note.ask != null && Store.isAnswered(note.cardId())) { answeredCount++; }
        }
        long lastSeq = list.isEmpty() ? 0 : list.get(list.size() - 1).seq;
        Store.Session now = Store.session(sessionId);
        String liveKey = now == null ? "" : (now.running + "|" + now.activity + "|" + now.activityDetail
            + "|" + Store.lastReplyText(sessionId).length());
        String key = header + "|" + list.size() + "|" + answeredCount + "|" + lastSeq + "|" + liveKey;
        if (key.equals(drawn)) { return; }
        drawn = key;

        String freshKey = list.size() + "|" + lastSeq;
        boolean fresh = !freshKey.equals(notesKey);
        notesKey = freshKey;
        // 重画之前先看人是不是贴着底：贴着才跟着新内容走，翻在上面看旧的就一眼也不动他
        boolean follow = atBottom();
        int keep = scroller.getScrollY();
        messages.removeAllViews();
        for (Store.Note note : list) {
            messages.addView(bubble(note));
        }
        // 「这一轮」摆在最后（跟聊天一样，最新的在最底下）：正在跑的时候能看它说到哪儿了；
        // 一条「有事」都还没有的时候也摆它 —— 那是刚重启过后端 / 刚才才连上，
        // 「有事」早就没了，而进来时拉回来的那条最后回复还在（见 fetchDetail），
        // 不摆的话人就只能对着一屏空白等下一次推送。
        // 跑完了、也已经收到过「有事」的话不摆：那一轮的原话就是最后那条，不必两份。
        View live = null;
        if (now != null && (now.running || list.isEmpty())) {
            live = liveCard(now);
            if (live != null) { messages.addView(live); }
        }
        // 这个会话连“有这一行”都还轮不上（列表里点进来的那条已经没了）：至少说一声
        if (list.isEmpty() && now == null) {
            TextView hint = new TextView(this);
            hint.setText("这个会话还没有消息。");
            hint.setTextSize(14);
            hint.setTextColor(0xFF8A8A8A);
            hint.setPadding(0, dp(16), 0, 0);
            messages.addView(hint);
        }
        final View liveView = live;
        scroller.post(() -> {
            // 来了新的、人又贴着底：滚到「这一轮」那张卡的开头（这样「正在跑…」那一行也看得到），
            // 没有卡片就照旧滚到最底下。
            if (fresh && follow) {
                if (liveView != null) { scroller.scrollTo(0, liveView.getTop()); }
                else { scroller.fullScroll(View.FOCUS_DOWN); }
                return;
            }
            // 没来新的、或者人正翻在上面看旧的：还他原来的位置，别拽他
            scroller.scrollTo(0, keep);
        });
    }

    /** 人是不是已经贴着底了（24 dp 的宽限）：贴着才跟着新内容走，翻在上面看旧的不算。 */
    private boolean atBottom() {
        if (scroller == null) { return true; }
        return scroller.getScrollY() + scroller.getHeight() >= messages.getHeight() - dp(24);
    }

    /** 「这一轮」那张卡：正在跑就在这儿看它说到哪儿了。 */
    private View liveCard(Store.Session session) {
        boolean running = session != null && session.running;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(12), dp(8), dp(12), dp(10));
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xFFFFFFFF);
        background.setCornerRadius(dp(12));
        background.setStroke(dp(1), 0xFFE3E3E3);
        box.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        box.setLayoutParams(params);

        // 只有正文，不另写一行「正在跑」：头顶那行状态字不要了
        JSONObject reply = Store.lastReply(sessionId);
        String text = reply == null ? "" : reply.optString("text", "");
        if (text.trim().isEmpty()) {
            TextView hint = new TextView(this);
            hint.setText(running ? "（还没开始说话）" : "（这个会话还没有跑完过一轮）");
            hint.setTextSize(13);
            hint.setTextColor(0xFF9A9A9A);
            box.addView(hint);
            return box;
        }

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        Markdown.render(this, body, reply.optJSONArray("blocks"), text, 14, 0xFF202020, 0xFF7A7A7A);
        box.addView(body);
        return box;
    }

    /** 一条：对方发的靠左、底色浅灰；自己发的靠右、底色浅蓝。 */
    private View bubble(Store.Note note) {
        boolean mine = "me".equals(note.kind);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(mine ? Gravity.END : Gravity.START);
        row.setPadding(0, dp(4), 0, dp(4));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(12), dp(8), dp(12), dp(8));
        GradientDrawable background = new GradientDrawable();
        background.setColor(mine ? 0xFFD9E9FF : 0xFFF0F0F0);
        background.setCornerRadius(dp(12));
        box.setBackground(background);

        TextView meta = new TextView(this);
        StringBuilder line = new StringBuilder();
        if (!note.from.isEmpty()) { line.append("来自 ").append(note.from).append(" · "); }
        if ("ask".equals(note.kind)) { line.append("在等你答一句 · "); }
        line.append(Store.fullTime(note.at));
        meta.setText(line.toString());
        meta.setTextSize(11);
        meta.setTextColor(0xFF7A7A7A);
        box.addView(meta);

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        if (note.text.isEmpty()) {
            TextView none = new TextView(this);
            none.setText("（没有文字）");
            none.setTextSize(15);
            none.setTextColor(0xFF202020);
            body.addView(none);
        } else {
            // 跑完那一轮可能很长，也可能带 markdown：后端已经把「怎么画」解析好了（见 Markdown.java）
            Markdown.render(this, body, note.blocks, note.text, 15, 0xFF202020, 0xFF7A7A7A);
        }
        box.addView(body);

        if (note.ask != null) { box.addView(askBlock(note)); }

        row.addView(box);
        return row;
    }

    /** 一道题：选项按钮 / 勾选框，能自己写一句；答过以后都灰掉、写一句「已答」。 */
    private View askBlock(Store.Note note) {
        JSONObject ask = note.ask;
        boolean answered = Store.isAnswered(note.cardId());
        boolean multi = ask.optBoolean("multi", false);
        boolean allowText = ask.optBoolean("allowText", true);

        List<String> options = new ArrayList<>();
        JSONArray array = ask.optJSONArray("options");
        if (array != null) {
            for (int i = 0; i < array.length(); i++) { options.add(array.optString(i, "")); }
        }
        Set<Integer> recommended = new HashSet<>();
        JSONArray rec = ask.optJSONArray("recommended");
        if (rec != null) {
            for (int i = 0; i < rec.length(); i++) { recommended.add(rec.optInt(i, 0)); }
        }

        LinearLayout block = new LinearLayout(this);
        block.setOrientation(LinearLayout.VERTICAL);
        block.setPadding(0, dp(6), 0, 0);

        List<CheckBox> checks = new ArrayList<>();
        List<View> switches = new ArrayList<>();
        for (int i = 0; i < options.size(); i++) {
            final String option = options.get(i);
            String label = option + (recommended.contains(i + 1) ? "　（我推荐）" : "");
            if (multi) {
                CheckBox check = new CheckBox(this);
                check.setText(label);
                check.setTextSize(14);
                check.setEnabled(!answered);
                check.setTag(option);
                checks.add(check);
                switches.add(check);
                block.addView(check);
            } else {
                Button button = new Button(this);
                button.setText(label);
                button.setAllCaps(false);
                button.setTextSize(14);
                button.setEnabled(!answered);
                button.setOnClickListener(v ->
                    sendAnswer(note, Collections.singletonList(option), "", switches));
                switches.add(button);
                block.addView(button);
            }
        }

        EditText free = null;
        if (allowText) {
            free = new EditText(this);
            free.setHint("自己写一句");
            free.setTextSize(14);
            free.setSingleLine(false);
            free.setMaxLines(4);
            free.setEnabled(!answered);
            block.addView(free);
        }

        // 多选要一颗「发送」；单选又能自己写时也要一颗（选项点一下就发，这句靠它发）
        if (multi || allowText) {
            Button sendButton = new Button(this);
            sendButton.setText("发送");
            sendButton.setAllCaps(false);
            sendButton.setTextSize(14);
            sendButton.setEnabled(!answered);
            final EditText freeBox = free;
            sendButton.setOnClickListener(v -> {
                List<String> picks = new ArrayList<>();
                for (CheckBox check : checks) {
                    if (check.isChecked()) { picks.add(String.valueOf(check.getTag())); }
                }
                String written = freeBox == null ? "" : freeBox.getText().toString().trim();
                if (picks.isEmpty() && written.isEmpty()) {
                    Toast.makeText(this, "先选一项、或者自己写一句", Toast.LENGTH_SHORT).show();
                    return;
                }
                sendAnswer(note, picks, written, switches);
            });
            switches.add(sendButton);
            block.addView(sendButton);
        }

        if (answered) {
            TextView done = new TextView(this);
            done.setText("已答");
            done.setTextSize(12);
            done.setTextColor(0xFF7A7A7A);
            done.setPadding(0, dp(4), 0, 0);
            block.addView(done);
        }
        return block;
    }

    /** 把答案送回去（POST /phone/answer）；没答上的原因用 Toast 说出来。 */
    private void sendAnswer(Store.Note note, List<String> picks, String text, List<View> disable) {
        final String base = Settings.baseUrl(this);
        if (base.isEmpty()) {
            Toast.makeText(this, "还没填后端地址", Toast.LENGTH_SHORT).show();
            return;
        }
        final String cardId = note.cardId();
        final JSONObject body = new JSONObject();
        try {
            body.put("cardId", cardId);
            body.put("picks", new JSONArray(picks));
            body.put("text", text);
        } catch (Exception ignored) {
            // 这几个都是简单值，放不进去只可能是内存都没了
        }
        for (View view : disable) { view.setEnabled(false); }
        new Thread(() -> {
            try {
                JSONObject res = Store.post(base + "/phone/answer", body);
                if (res.optBoolean("ok", false)) {
                    Store.markAnswered(cardId);
                } else {
                    ui.post(() -> {
                        for (View view : disable) { view.setEnabled(true); }
                        Toast.makeText(this, "没答上去：" + Store.reason(res), Toast.LENGTH_LONG).show();
                    });
                }
            } catch (Exception e) {
                ui.post(() -> {
                    for (View view : disable) { view.setEnabled(true); }
                    Toast.makeText(this, "没答上去：" + Store.reason(e), Toast.LENGTH_LONG).show();
                });
            }
        }, "phone-answer").start();
    }

    /** 回一句（POST /phone/send）：成了先自己上屏，后端再推回来的那条就不会重复。 */
    private void sendText() {
        final String text = input.getText().toString().trim();
        if (text.isEmpty()) { return; }
        final String base = Settings.baseUrl(this);
        if (base.isEmpty()) {
            Toast.makeText(this, "还没填后端地址", Toast.LENGTH_SHORT).show();
            return;
        }
        final String id = sessionId;
        final String name = title.getText().toString();
        send.setEnabled(false);
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("sessionId", id).put("text", text);
                JSONObject res = Store.post(base + "/phone/send", body);
                if (res.optBoolean("ok", false)) {
                    ui.post(() -> input.setText(""));
                    Store.addLocalMe(id, name, text);
                } else {
                    ui.post(() -> Toast.makeText(this, "没发出去：" + Store.reason(res), Toast.LENGTH_LONG).show());
                }
            } catch (Exception e) {
                ui.post(() -> Toast.makeText(this, "没发出去：" + Store.reason(e), Toast.LENGTH_LONG).show());
            } finally {
                ui.post(() -> send.setEnabled(true));
            }
        }, "phone-send").start();
    }

    /** 进来时跟后端要一份（GET /phone/session）：长连接上漏掉的、别处答过的，这一下对齐。 */
    private void fetchDetail() {
        final String base = Settings.baseUrl(this);
        final String id = sessionId;
        if (base.isEmpty() || id.isEmpty()) { return; }
        new Thread(() -> {
            try {
                String url = base + "/phone/session?id="
                    + URLEncoder.encode(id, StandardCharsets.UTF_8.name());
                JSONObject res = Store.get(url);
                if (res.optBoolean("ok", true)) {
                    Store.applyDetail(id, res.optJSONObject("session"), res.optJSONArray("notes"),
                        res.optJSONObject("lastReply"));
                    ui.post(() -> { if (!isFinishing()) { render(); } });
                } else {
                    ui.post(() -> Toast.makeText(this, Store.reason(res), Toast.LENGTH_LONG).show());
                }
            } catch (Exception e) {
                ui.post(() -> Toast.makeText(this, "拉这个会话没成功：" + Store.reason(e), Toast.LENGTH_LONG).show());
            }
        }, "phone-session").start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String id = intent.getStringExtra(EXTRA_SESSION);
        if (id != null && !id.isEmpty() && !id.equals(sessionId)) {
            sessionId = id;
            drawn = "";
            notesKey = "";
            input.setText("");
            Store.setViewing(sessionId);
            render();
        }
        String name = intent.getStringExtra(EXTRA_NAME);
        if (name != null && !name.isEmpty()) { title.setText(name); }
        fetchDetail();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Store.setViewing(sessionId);
        render();
        fetchDetail();
        ui.post(liveTick);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(liveTick);
        if (Store.isViewing(sessionId)) { Store.setViewing(""); }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        Store.unlisten(onChange);
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
