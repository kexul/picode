package dev.pichat.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 一屏：上面填后端地址、开那颗开关，下面直接是网页端本身（看会话、回话都在里面）。
 *
 * 不另外写一套对话界面：手机上打开后端那个地址看到的就是这一份，嵌进来就全都有了。
 * 通知点进来时带着会话标识，页面就绪以后让它切到那个会话（跟顶条上点一下那格一样）。
 */
public class MainActivity extends Activity {
    /** 通知点进来时带的会话标识（要切过去的那个会话）。 */
    static final String EXTRA_SESSION = "sessionId";

    private EditText urlBox;
    private Switch toggle;
    private TextView statusLine;
    private LinearLayout settingsPanel;
    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 通知点进来要切过去的会话：页面还没载好时先记着，载好了再说。 */
    private String pendingSession;
    /** 已经跟后端说了几次「切到那个会话」（页面刚载好时可能还没连上，说几次）。 */
    private int switchTries;
    /** 页面载完没（载完才叫它切：刚载到一半时它还没连上后端）。 */
    private boolean pageLoaded;
    private boolean resumed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Notifier.ensureChannels(this);
        setContentView(buildUi());

        String saved = Settings.baseUrl(this);
        urlBox.setText(saved);
        toggle.setChecked(Settings.on(this) && !saved.isEmpty());
        if (toggle.isChecked()) { PhoneService.start(this); }
        loadPage(saved);
        // 还没填地址：把那行摊开来（填完就收回去，平时整屏都是网页）
        showSettings(saved.isEmpty());
        handleIntent(getIntent());
        askNotificationPermission();
    }

    private View buildUi() {
        final int pad = Math.round(8 * getResources().getDisplayMetrics().density);
        final int barHeight = Math.round(30 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // 顶头那条细线：只剩右边一颗「后端地址」按钮（连接状态看通知栏那条常驻通知，
        // 或者点开这行以后看下面那行小灰字）
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);

        android.widget.ImageButton tune = new android.widget.ImageButton(this);
        tune.setImageResource(R.drawable.ic_tune);
        tune.setBackgroundColor(0x00000000);
        tune.setContentDescription("后端地址");
        tune.setOnClickListener(v -> showSettings(settingsPanel.getVisibility() != View.VISIBLE));
        topBar.addView(tune, new LinearLayout.LayoutParams(barHeight + pad, barHeight));
        root.addView(topBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barHeight));

        // 设置那一块（地址、开关、现在连到哪儿了）：默认收起来，点右边那颗才摊开
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

        toggle = new Switch(this);
        toggle.setText("收提醒");
        toggle.setOnCheckedChangeListener((v, checked) -> onToggle(checked));
        bar.addView(toggle);
        settingsPanel.addView(bar);

        // 现在连到哪儿了：平时收着不显示，摊开这一块时看得到
        statusLine = new TextView(this);
        statusLine.setTextSize(11);
        statusLine.setSingleLine(true);
        statusLine.setTextColor(0xFF8A8A8A);
        statusLine.setPadding(pad, 0, pad, pad);
        settingsPanel.addView(statusLine);
        root.addView(settingsPanel);

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageLoaded = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                applyPendingSwitch();
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                // 打不开（地址写错了 / 后端没开 / 不在同一个网）：把那行摊开来让人改
                if (request != null && request.isForMainFrame()) { showSettings(true); }
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 键盘弹出来时网页让出位置，别把输入框盖住
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        return root;
    }

    /** 那行设置露不露出来（网页本身占满剩下的地方）。 */
    private void showSettings(boolean show) {
        settingsPanel.setVisibility(show ? View.VISIBLE : View.GONE);
    }
    /** 「保存」：存下地址、打开开关、开始收提醒、把页面载进来。 */
    private void onSave() {
        String url = Settings.normalize(urlBox.getText().toString());
        urlBox.setText(url);
        if (url.isEmpty()) {
            Toast.makeText(this, "先填后端地址（浏览器里打开后端时那个地址）", Toast.LENGTH_SHORT).show();
            return;
        }
        Settings.setBaseUrl(this, url);
        if (!Settings.on(this)) {
            Settings.setOn(this, true);
            toggle.setChecked(true);
        }
        loadPage(url);
        // 存好了就把这行收回去：平时整屏都是网页
        showSettings(false);
    }

    /** 那颗开关：关了就停收（常驻通知也跟着没了），开了就接着收。 */
    private void onToggle(boolean checked) {
        Settings.setOn(this, checked);
        if (!checked) {
            PhoneService.stop(this);
            return;
        }
        if (Settings.baseUrl(this).isEmpty()) {
            Toast.makeText(this, "先在上面填后端地址再打开", Toast.LENGTH_SHORT).show();
            return;
        }
        PhoneService.start(this);
    }

    private void loadPage(String url) {
        if (url == null || url.isEmpty()) {
            web.loadData("<html><body style=\"font:15px sans-serif;padding:24px;color:#666\">"
                + "上面填后端地址（就是浏览器里打开 Pi Chat 时那个地址），保存以后这里就是对话页面。</body></html>",
                "text/html", "utf-8");
            return;
        }
        if (!url.equals(web.getUrl())) { web.loadUrl(url); }
    }

    /** 通知点进来带的那条会话标识。 */
    private void handleIntent(Intent intent) {
        if (intent == null) { return; }
        String session = intent.getStringExtra(EXTRA_SESSION);
        if (session != null && !session.isEmpty()) {
            pendingSession = session;
            switchTries = 0;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
        applyPendingSwitch();
    }

    /**
     * 让开着的页面切到通知说的那个会话。
     *
     * 自己不往页面里塞脚本（那要靠页面内部的东西，一变就不管用了），而是叫后端说一句：
     * `POST /switch`，跟有人点了右下角那张提醒卡一个走法（后端广播给每个开着的页面）。
     * 页面刚载完那一小会儿可能还没连上后端，那就过一会儿再说，几次还不行就算了——
     * 人自己点顶条上那格也一样。
     */
    private void applyPendingSwitch() {
        final String session = pendingSession;
        if (session == null || !pageLoaded) { return; }
        requestSwitch(session);
        if (++switchTries >= 3) {
            pendingSession = null;
            return;
        }
        ui.postDelayed(this::applyPendingSwitch, switchTries == 1 ? 1200 : 2500);
    }

    /** 跟后端说一句「把开着的页面切到这个会话」。 */
    private void requestSwitch(String sessionId) {
        final String base = Settings.baseUrl(this);
        if (base.isEmpty() || sessionId == null || sessionId.isEmpty()) { return; }
        final String body = "{\"sessionId\":" + org.json.JSONObject.quote(sessionId) + "}";
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(base + "/switch").openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
                Log.d("pichat-phone", "说要切到 " + sessionId + "：HTTP " + conn.getResponseCode());
            } catch (Exception ignored) {
                // 切不过去就算了：人自己点顶条上那格也一样
            } finally {
                if (conn != null) { conn.disconnect(); }
            }
        }, "switch-session").start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        ui.post(statusTick);
    }

    @Override
    protected void onPause() {
        resumed = false;
        ui.removeCallbacks(statusTick);
        super.onPause();
    }

    /** 底下那行小字：现在连到哪儿了（每秒看一眼，省一套监听）。 */
    private final Runnable statusTick = new Runnable() {
        @Override
        public void run() {
            if (!resumed) { return; }
            boolean on = Settings.on(MainActivity.this) && !Settings.baseUrl(MainActivity.this).isEmpty();
            statusLine.setText(on ? PhoneService.status() : "收提醒关着：填上地址，把「收提醒」打开");
            ui.postDelayed(this, 1000);
        }
    };

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
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
}
