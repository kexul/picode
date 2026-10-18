package dev.pichat.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;

/**
 * 打开 App 看到的就是后端那份对话页面 —— 一个壳里装着一块浏览器。
 *
 * 这里只做壳该做的事：
 *   - 地址表：还没连过就先让人填一个；连过的地址排成一列，点一下就换过去；
 *   - 打开时按清单顺序试一遍，第一个连得上的就用（家里那个 http 和出门那个 https 都写上，
 *     在哪都能打开，不用手动换）；
 *   - 把后台那条连接（{@link WatchService}）拉起来；
 *   - 点通知回来时，让页面切到那个会话（页面里留了口子：window.pichatOpenSession）；
 *   - 告诉页面"我在壳里"：网页那边就不再自己弹浏览器通知了，全归壳发（不然会弹两条）。
 */
public class MainActivity extends Activity {
    /** 通知点进来时带的会话标识。 */
    static final String EXTRA_SESSION = "sessionId";

    /** 现在有没有人正在看这个 App：后台服务据此决定要不要弹通知（开着就别打扰）。 */
    static boolean visible = false;

    private static final int REQ_FILE = 1001;
    private static final int REQ_NOTIFY = 1002;

    private WebView web;
    private View home;
    private EditText addrInput;
    private TextView note;
    private TextView savedTitle;
    private LinearLayout savedList;
    private Button goButton;

    /** 现在连的是哪个地址（空串 = 还没连上）。 */
    private String base = "";
    /** 页面这一份加载完了没有（没加载完就别往里执行切换会话那句）。 */
    private boolean pageLoaded = false;
    /** 通知让切到哪个会话；页面加载完 / 回来之后再去切。 */
    private String pendingSession;

    private WebChromeClient.FileChooserParams fileParams;
    private android.webkit.ValueCallback<Uri[]> fileCallback;

    /**
     * 页面一跑起来先放这几个标记：
     *   pichatInAppShell —— “我在手机 App 里”：页面据此不再自己弹浏览器通知；
     *   顺手把 window.Notification 摘掉，免得将来有哪段代码绕过那个判断又弹一遍。
     */
    private static final String SHELL_JS =
        "(function(){try{"
            + "window.pichatInAppShell=true;"
            + "try{Object.defineProperty(window,'Notification',{value:undefined,writable:true,configurable:true});}catch(e){window.Notification=undefined;}"
            + "}catch(e){}})();";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        home = findViewById(R.id.home);
        addrInput = findViewById(R.id.addr);
        note = findViewById(R.id.note);
        savedTitle = findViewById(R.id.savedTitle);
        savedList = findViewById(R.id.saved);
        goButton = findViewById(R.id.go);

        setUpWeb();

        goButton.setOnClickListener((v) -> {
            String want = Prefs.normalize(addrInput.getText().toString());
            if (want.isEmpty()) {
                note.setText("这个地址看着不对。要写成 http://192.168.1.5:51883/ 这样。");
                return;
            }
            Prefs.remember(this, want);
            renderSaved();
            open(want);
        });

        handleIntent(getIntent());
        List<String> saved = Prefs.addresses(this);
        renderSaved();
        if (saved.isEmpty()) {
            showHome("第一次用：把后端地址填进来。后端要在这台电脑上跑着（终端里敲 pichat）。");
        } else {
            addrInput.setText(saved.get(0));
            pickAndOpen(saved);
        }
    }

    // ==================== 打开 ====================

    /** 按清单顺序试一遍，第一个连得上的就用。探活放在后台线程，别卡界面。 */
    private void pickAndOpen(List<String> candidates) {
        note.setText("正在找能连上的地址…");
        new Thread(() -> {
            String found = null;
            for (String candidate : candidates) {
                if (alive(candidate)) { found = candidate; break; }
            }
            String hit = found;
            runOnUiThread(() -> {
                if (hit != null) {
                    open(hit);
                } else {
                    showHome("这些地址都连不上：\n" + String.join("\n", candidates)
                        + "\n\n后端开着吗？手机和电脑在同一个网里吗？");
                }
            });
        }, "probe").start();
    }

    /** 这个地址上的后端在不在（拿 /health 问一声，2.5 秒内不答就算不在）。 */
    private static boolean alive(String candidate) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(candidate + "health").openConnection();
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
            conn.setUseCaches(false);
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) { conn.disconnect(); }
        }
    }

    /** 连这个地址：把网页装上、把后台那条连接拉起来。 */
    private void open(String candidate) {
        base = candidate;
        Prefs.remember(this, candidate);
        addrInput.setText(candidate);
        renderSaved();
        home.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        pageLoaded = false;
        web.loadUrl(candidate);
        startWatch(candidate);
        askNotifyPermission();
    }

    private void showHome(String text) {
        note.setText(text);
        home.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
        renderSaved();
    }

    /** 用过的地址排成几行，点一行就换过去。 */
    private void renderSaved() {
        List<String> list = Prefs.addresses(this);
        savedList.removeAllViews();
        savedTitle.setVisibility(list.isEmpty() ? View.GONE : View.VISIBLE);
        for (String item : list) {
            TextView row = new TextView(this);
            row.setText(item);
            row.setTextSize(15);
            row.setPadding(0, 18, 0, 18);
            boolean current = item.equals(base);
            row.setTextColor(current ? 0xFF1F6FEB : 0xFF202020);
            row.setOnClickListener((v) -> open(item));
            savedList.addView(row);
        }
    }

    private void startWatch(String candidate) {
        Intent intent = new Intent(this, WatchService.class).putExtra(WatchService.EXTRA_BASE, candidate);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    // ==================== 网页那片 ====================

    private void setUpWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // 界面把"上次收起侧边栏"这类小状态存在本机，没有这块存储就会每次打开都变回默认
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(false);
        // 手机上用一个普通的移动浏览器身份：后端按普通浏览器那条路给页面
        s.setUserAgentString(s.getUserAgentString() + " PiChatApp/0.1");
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // 只接管"不是本后端"的链接（仓库地址、文档链接这些）：交给系统浏览器，
                // 别让它们把这层壳顶掉，回不来了
                String host = uri.getHost();
                String ownHost = Uri.parse(base.isEmpty() ? "http://none/" : base).getHost();
                if (host != null && host.equals(ownHost)) { return false; }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(MainActivity.this, "这台手机上打不开这个链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                web.evaluateJavascript(SHELL_JS, null);
                pageLoaded = true;
                openPendingSession();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) { fileCallback.onReceiveValue(null); }
                fileCallback = callback;
                fileParams = params;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    fileParams = null;
                    return false;
                }
            }
        });

        // 页面里有下载（截图、导出的文件）：交给系统下载器，通知栏能看到进度
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                dm.enqueue(req);
                Toast.makeText(this, "开始下载", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "下载没成功：" + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(
                    fileParams == null ? null : WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
                fileParams = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ==================== 通知 ====================

    /** 安卓 13 起要先问一次才给弹通知；数据库里记的那条常驻通知同理。 */
    private void askNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33) { return; }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) { return; }
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFY);
    }

    // ==================== 点通知回来 ====================

    /** 通知里带了"哪个会话"：页面加载完 / 已经开着，就去切过去。 */
    private void handleIntent(Intent intent) {
        if (intent == null) { return; }
        String sessionId = intent.getStringExtra(EXTRA_SESSION);
        if (sessionId == null || sessionId.isEmpty()) { return; }
        pendingSession = sessionId;
        intent.removeExtra(EXTRA_SESSION);
        openPendingSession();
    }

    private void openPendingSession() {
        if (pendingSession == null || !pageLoaded || web.getVisibility() != View.VISIBLE) { return; }
        String sessionId = pendingSession;
        pendingSession = null;
        String js = "window.pichatOpenSession && window.pichatOpenSession(" + JSONObject.quote(sessionId) + ")";
        web.evaluateJavascript(js, null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    // ==================== 生命周期 / 返回键 ====================

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        // 通知点进来时 App 已经开着：Activity 可能还在后台那份状态上，这会儿再切一次
        openPendingSession();
    }

    @Override
    protected void onPause() {
        visible = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        // 别把网页里的连接留在这儿：壳没了网页也就没用了
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }

    /** 连按两次返回才退出：一次按错不至于把正在看的对话关掉。 */
    private long lastBackAt = 0;

    @Override
    public void onBackPressed() {
        if (home.getVisibility() == View.VISIBLE && !base.isEmpty()) {
            home.setVisibility(View.GONE);
            web.setVisibility(View.VISIBLE);
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次退出（后台那条连接还在，通知照样收得到）", Toast.LENGTH_SHORT).show();
    }
}
