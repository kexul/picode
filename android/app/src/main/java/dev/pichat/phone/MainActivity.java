package dev.pichat.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * 一屏会话列表：一行一个会话，有事的排前面，点一行进去看那个会话。
 *
 * 顶上一颗「设置」：点它摊开填后端地址那一块，底下写着现在连到哪儿了（已连上 / 重连中…）。
 * 地址还没填时它自己摊开，并且收不起来（那时还没有别的地方能填）。
 * 长连接正断着、列表又空的时候，中间有一句人话和一颗「重新连」。
 *
 * 数据都在 Store 里（收提醒的服务一直在往里写），这儿只是照着摆。
 */
public class MainActivity extends Activity {
    /** 常驻通知点进来时带的标记：把填地址那一块摊开。 */
    static final String EXTRA_SETTINGS = "openSettings";

    private EditText urlBox;
    private TextView statusLine;
    private LinearLayout settingsPanel;
    private LinearLayout list;
    private LinearLayout emptyBox;
    private TextView emptyLine;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean resumed;
    /** 进这个界面以后拉过一次列表没有（省得来回切都去问一遍）。 */
    private boolean askedSessions;
    private final Runnable onChange = () -> {
        if (!isFinishing()) { refreshList(); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Notifier.ensureChannels(this);
        setContentView(buildUi());

        String saved = Settings.baseUrl(this);
        urlBox.setText(saved);
        showSettings(saved.isEmpty());
        Store.listen(onChange);
        refreshList();

        handleIntent(getIntent());
        if (!saved.isEmpty()) {
            PhoneService.start(this);
            fetchSessions(true);
        }
        askNotificationPermission();
    }

    private View buildUi() {
        int pad = dp(10);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // 顶上一行：名字 + 设置
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(pad, pad, pad, pad);

        TextView name = new TextView(this);
        name.setText("Pi Chat");
        name.setTextSize(20);
        name.setTextColor(0xFF1E1E1E);
        name.setTypeface(null, Typeface.BOLD);
        header.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView settings = new TextView(this);
        settings.setText("设置");
        settings.setTextSize(14);
        settings.setTextColor(0xFF3A6EA5);
        settings.setPadding(pad, pad / 2, 0, pad / 2);
        settings.setOnClickListener(v -> showSettings(settingsPanel.getVisibility() != View.VISIBLE));
        header.addView(settings);
        root.addView(header);

        // 填地址那一块（地址、保存、现在连到哪儿了）：平时收着
        settingsPanel = new LinearLayout(this);
        settingsPanel.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(pad, 0, pad, 0);

        urlBox = new EditText(this);
        urlBox.setHint("后端地址，例如 100.64.0.2:51883");
        urlBox.setSingleLine(true);
        urlBox.setTextSize(14);
        urlBox.setImeOptions(EditorInfo.IME_ACTION_DONE);
        bar.addView(urlBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button save = new Button(this);
        save.setText("保存");
        save.setOnClickListener(v -> onSave());
        bar.addView(save);
        settingsPanel.addView(bar);

        LinearLayout foot = new LinearLayout(this);
        foot.setOrientation(LinearLayout.HORIZONTAL);
        foot.setGravity(Gravity.CENTER_VERTICAL);
        foot.setPadding(pad, 0, pad, pad);

        statusLine = new TextView(this);
        statusLine.setTextSize(11);
        statusLine.setSingleLine(true);
        statusLine.setTextColor(0xFF8A8A8A);
        foot.addView(statusLine, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView hide = new TextView(this);
        hide.setText("收起");
        hide.setTextSize(12);
        hide.setTextColor(0xFF6A6A6A);
        hide.setPadding(pad, pad / 2, pad, pad / 2);
        hide.setOnClickListener(v -> showSettings(false));
        foot.addView(hide);
        settingsPanel.addView(foot);
        root.addView(settingsPanel);

        // 中间：列表；没有会话时摆一句人话和一颗「重新连」
        FrameLayout content = new FrameLayout(this);

        ScrollView scroller = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(pad, 0, pad, pad);
        scroller.addView(list, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(scroller, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        emptyBox = new LinearLayout(this);
        emptyBox.setOrientation(LinearLayout.VERTICAL);
        emptyBox.setGravity(Gravity.CENTER);
        emptyBox.setPadding(pad, 0, pad, 0);

        emptyLine = new TextView(this);
        emptyLine.setTextSize(14);
        emptyLine.setTextColor(0xFF8A8A8A);
        emptyLine.setGravity(Gravity.CENTER);
        emptyBox.addView(emptyLine);

        Button reconnect = new Button(this);
        reconnect.setText("重新连");
        reconnect.setAllCaps(false);
        reconnect.setOnClickListener(v -> onReconnect());
        emptyBox.addView(reconnect);
        content.addView(emptyBox, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(content, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        return root;
    }

    /** 填地址那一块露不露出来。地址还没填时收不起来（那时别处没有入口）。 */
    private void showSettings(boolean show) {
        boolean visible = show || Settings.baseUrl(this).isEmpty();
        settingsPanel.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    /** 「保存」：存下地址、换一条连接、把列表重新要一份，然后把这行收回去。 */
    private void onSave() {
        String url = Settings.normalize(urlBox.getText().toString());
        urlBox.setText(url);
        if (url.isEmpty()) {
            Toast.makeText(this, "先填后端地址（浏览器里打开后端时那个地址）", Toast.LENGTH_SHORT).show();
            return;
        }
        boolean changed = !url.equals(Settings.baseUrl(this));
        Settings.setBaseUrl(this, url);
        if (changed) { Store.clear(); }
        PhoneService.reconnect(this);
        showSettings(false);
        emptyLine.setText("正在连…");
        fetchSessions(true);
    }

    /** 手动刷新：再连一次，同时问后端要一份列表（长连接可能正断着）。 */
    private void onReconnect() {
        if (Settings.baseUrl(this).isEmpty()) {
            showSettings(true);
            return;
        }
        emptyLine.setText("正在重新连…");
        PhoneService.reconnect(this);
        fetchSessions(true);
    }

    /** 列表的简版（GET /phone/sessions）：长连接还没连上时先靠它把这一屏填上。 */
    private void fetchSessions(boolean complain) {
        final String base = Settings.baseUrl(this);
        if (base.isEmpty()) { return; }
        askedSessions = true;
        new Thread(() -> {
            try {
                JSONObject res = Store.get(base + "/phone/sessions");
                JSONArray array = res.optJSONArray("sessions");
                if (array != null) { Store.applySessions(array); }
            } catch (Exception e) {
                ui.post(() -> {
                    if (!complain || isFinishing()) { return; }
                    if (!Store.sessions().isEmpty()) { return; }
                    // 连不上（地址写错了 / 后端没开 / 不在同一个网）：跟原来一样，把填地址那块摊开
                    emptyLine.setText("连不上后端，看看地址对不对（" + Store.reason(e) + "）");
                    showSettings(true);
                });
            }
        }, "phone-sessions").start();
    }

    /** 照着 Store 里那份，把列表重摆一遍。 */
    private void refreshList() {
        if (list == null || isFinishing()) { return; }
        list.removeAllViews();
        List<Store.Session> sessions = Store.sessions();
        boolean hasAddress = !Settings.baseUrl(this).isEmpty();
        if (sessions.isEmpty()) {
            emptyBox.setVisibility(View.VISIBLE);
            emptyLine.setText(hasAddress
                ? "现在没有开着会话。在电脑上开一个，这里就会出现。"
                : "还没填后端地址。点右上角「设置」填一下。");
            return;
        }
        emptyBox.setVisibility(View.GONE);
        for (Store.Session session : sessions) {
            list.addView(row(session));
        }
    }

    /** 列表上一行：状态点、会话名、最后一条的一两句、时间。 */
    private View row(Store.Session session) {
        int pad = dp(10);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(pad, pad, pad, pad);
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xFFF7F7F7);
        background.setCornerRadius(dp(10));
        row.setBackground(background);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rowParams.bottomMargin = dp(6);
        row.setLayoutParams(rowParams);

        // 状态点：跟网页端一个规矩 —— 正在跑是蓝点、呼吸；闲着（跑完了）是绿点、不闪
        TextView dot = new TextView(this);
        dot.setText("●");
        dot.setTextSize(10);
        dot.setTextColor(session.running ? 0xFF2F7BE0 : 0xFF2E7D32);
        if (session.running) {
            android.animation.ObjectAnimator anim = android.animation.ObjectAnimator.ofFloat(dot, "alpha", 1f, 0.3f);
            anim.setDuration(700);
            anim.setRepeatMode(android.animation.ValueAnimator.REVERSE);
            anim.setRepeatCount(android.animation.ValueAnimator.INFINITE);
            anim.start();
        }
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dotParams.rightMargin = dp(6);
        row.addView(dot, dotParams);

        LinearLayout middle = new LinearLayout(this);
        middle.setOrientation(LinearLayout.VERTICAL);
        row.addView(middle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView name = new TextView(this);
        name.setText(session.name);
        name.setTextSize(16);
        name.setTextColor(0xFF1E1E1E);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        middle.addView(name);

        Store.Note last = session.last;
        if (last != null) {
            TextView summary = new TextView(this);
            summary.setText(summary(last));
            summary.setTextSize(13);
            summary.setTextColor(0xFF6A6A6A);
            summary.setMaxLines(2);
            summary.setEllipsize(TextUtils.TruncateAt.END);
            middle.addView(summary);

            if (Store.waitingAnswer(session.id)) {
                TextView waiting = new TextView(this);
                waiting.setText("在等你答一句");
                waiting.setTextSize(12);
                waiting.setTextColor(0xFFB26A00);
                middle.addView(waiting);
            }
        } else {
            TextView none = new TextView(this);
            none.setText("还没有新的事");
            none.setTextSize(13);
            none.setTextColor(0xFF9A9A9A);
            middle.addView(none);
        }

        TextView time = new TextView(this);
        time.setText(Store.shortTime(last == null ? 0 : last.at));
        time.setTextSize(12);
        time.setTextColor(0xFF9A9A9A);
        LinearLayout.LayoutParams timeParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        timeParams.leftMargin = dp(8);
        row.addView(time, timeParams);

        row.setOnClickListener(v -> startActivity(new Intent(this, SessionActivity.class)
            .putExtra(SessionActivity.EXTRA_SESSION, session.id)
            .putExtra(SessionActivity.EXTRA_NAME, session.name)));
        return row;
    }

    /** 列表上那一两句：跑完是回复开头，问的是题干，自己说的是「我：」。换行压成空格。 */
    private static String summary(Store.Note note) {
        // 列表上只要一句话：后端已经压好了（老后端没有就自己收一下空白）
        String text = note.plain == null ? "" : note.plain.trim();
        if (text.isEmpty()) {
            text = note.text == null ? "" : note.text.replaceAll("\\s+", " ").trim();
        }
        if (text.isEmpty()) { text = "（没有文字）"; }
        if ("ask".equals(note.kind)) { return "问：" + text; }
        if ("me".equals(note.kind)) { return "我：" + text; }
        return text;
    }

    /** 点通知进来的：常驻那条要摊开填地址那块（别的入口已经直接进会话页了）。 */
    private void handleIntent(Intent intent) {
        if (intent == null) { return; }
        if (intent.getBooleanExtra(EXTRA_SETTINGS, false)) {
            showSettings(true);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        refreshList();
        ui.post(statusTick);
        // 从会话页回来、刚开的那一次没拉上（比如地址刚填）：补一次
        if (!askedSessions && !Settings.baseUrl(this).isEmpty()) { fetchSessions(true); }
    }

    @Override
    protected void onPause() {
        resumed = false;
        ui.removeCallbacks(statusTick);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        Store.unlisten(onChange);
        super.onDestroy();
    }

    /** 填地址那一块底下那行小字：现在连到哪儿了（每秒看一眼，省一套监听）。 */
    private final Runnable statusTick = new Runnable() {
        @Override
        public void run() {
            if (!resumed) { return; }
            boolean filled = !Settings.baseUrl(MainActivity.this).isEmpty();
            statusLine.setText(filled ? PhoneService.status() : "还没填后端地址");
            ui.postDelayed(this, 1000);
        }
    };

    @Override
    public void onBackPressed() {
        // 摊开的填地址那块先收起来（地址没填时收不起来，那就停在这儿）
        if (settingsPanel != null && settingsPanel.getVisibility() == View.VISIBLE) {
            showSettings(false);
            return;
        }
        super.onBackPressed();
    }

    /** 安卓 13 起发通知要先问一句（不问的话通知一条都不显示）。 */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) { return; }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) { return; }
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
