package dev.pichat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 后台那条一直连着的线：这里是"壳能一直连着、能推送通知"的全部。
 *
 * 干的事：
 *   1. 挂一条常驻通知栏条目（安卓不允许没有它还想长期活着），写着现在连着哪个地址、还是在重连；
 *   2. 自己开一条到后端 /events 的连接（role=watch：只听，不画界面，也不跟页面抢"最近在动的那块屏"），
 *      后端推下来的消息里只认两件：
 *        - turnEnd：某个会话跑完了一轮（别人派出去干活的子会话不弹、被停掉的那一轮不弹）；
 *        - askWaiting：模型在等你在某个会话里答一道选择题。
 *      收到就弹一条系统通知，点一下打开 App 并切到那个会话；
 *   3. 每 20 秒跟后端报一次活（后端 90 秒没动静就把连接收掉）；
 *   4. 断了就退避着重连（1、2、3、5、10、20、30 秒），连上之后从头算。
 *
 * 为什么不靠网页自己那条连接：App 退到后台后，网页那边会被系统冻住，连接迟早死掉。
 * 这条线不画界面，只干一件事，才守得住。
 */
public class WatchService extends Service {
    static final String EXTRA_BASE = "base";

    /** 常驻那条通知的编号（固定，更新它就不会在通知栏堆一片）。 */
    private static final int ONGOING_ID = 1;
    private static final String CH_ONGOING = "watch";
    private static final String CH_EVENTS = "events";
    /** 报活间隔：后端 90 秒收连接，20 秒报一次很宽裕，也不费电。 */
    private static final long PING_MS = 20_000;
    /** 断线后隔多久再试（毫秒），一路退到这个上限。 */
    private static final long[] RETRY_MS = { 1_000, 2_000, 3_000, 5_000, 10_000, 20_000, 30_000 };
    /** 连上超过这么久才断的，算"正常断"，重连间隔从头算。 */
    private static final long STABLE_MS = 60_000;
    /** 一条消息等多久算死（后端每 25 秒发一个心跳，80 秒还没动静就重连）。 */
    private static final int READ_TIMEOUT_MS = 80_000;

    private volatile boolean running;
    private volatile String base = "";
    private volatile HttpURLConnection stream;
    private Thread streamThread;
    private Thread pingThread;
    private String pageId = "";
    /** 只用来别把同一句话反复往通知栏上写。 */
    private String ongoingText = "";

    @Override
    public void onCreate() {
        super.onCreate();
        pageId = Prefs.pageId(this);
        createChannels();
        running = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String wanted = intent != null ? intent.getStringExtra(EXTRA_BASE) : null;
        if (wanted == null || wanted.isEmpty()) { wanted = Prefs.base(this); }

        // 先挂上常驻通知：从 startForegroundService 到这儿只有几秒，别超时。
        // 安卓 10 起把类型也报上（dataSync：同步这类消息），清单里也是这么声明的
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ONGOING_ID, ongoing(wanted.isEmpty() ? "还没有地址" : "连着 " + wanted),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ONGOING_ID, ongoing(wanted.isEmpty() ? "还没有地址" : "连着 " + wanted));
        }

        if (wanted != null && !wanted.isEmpty() && !wanted.equals(base)) {
            base = wanted;
            restartStream();
        } else if (streamThread == null || !streamThread.isAlive()) {
            restartStream();
        }
        if (pingThread == null || !pingThread.isAlive()) {
            pingThread = new Thread(this::pingLoop, "watch-ping");
            pingThread.setDaemon(true);
            pingThread.start();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection conn = stream;
        if (conn != null) { conn.disconnect(); }
        if (streamThread != null) { streamThread.interrupt(); }
        super.onDestroy();
    }

    // ==================== 那条连接 ====================

    private synchronized void restartStream() {
        HttpURLConnection conn = stream;
        if (conn != null) { conn.disconnect(); }
        if (streamThread != null) { streamThread.interrupt(); }
        streamThread = new Thread(this::runStream, "watch-stream");
        streamThread.setDaemon(true);
        streamThread.start();
    }

    private void runStream() {
        int attempt = 0;
        while (running) {
            String target = base;
            if (target.isEmpty()) {
                sleep(2_000);
                continue;
            }
            long startedAt = System.currentTimeMillis();
            try {
                readStream(target);
            } catch (Exception e) {
                // 连不上、断了、超时都走这条：下面的退避重连兜着
            }
            if (!running || !target.equals(base)) { continue; }
            if (System.currentTimeMillis() - startedAt > STABLE_MS) { attempt = 0; }
            long wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
            attempt++;
            setOngoing("连不上 " + base + "，正在重试");
            sleep(wait);
        }
    }

    /** 连上并一直读，直到断了/被掐掉；正常返回就代表该重连了。 */
    private void readStream(String target) throws Exception {
        URL url = new URL(target + "events?pageId=" + pageId + "&role=watch");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(8_000);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setRequestProperty("Accept", "text/event-stream");
        conn.setRequestProperty("Cache-Control", "no-store");
        stream = conn;
        try {
            if (conn.getResponseCode() != 200) {
                throw new IllegalStateException("后端回了 " + conn.getResponseCode());
            }
            setOngoing("连着 " + target);
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while (running && (line = reader.readLine()) != null) {
                    // 推送流里一行行读：长这样
                    //   event: msg
                    //   data: {"type":"turnEnd",...}
                    //   （空行）
                    // 只要 data 那几行，其他（心跳 tick、注释、retry）不用管
                    if (line.startsWith("data:")) {
                        onEvent(line.substring(5).trim());
                    }
                }
            }
        } finally {
            if (stream == conn) { stream = null; }
            conn.disconnect();
        }
    }

    /** 后端推下来一条。只认"跑完一轮"和"在等你答"这两件要人回来看一眼的事。 */
    private void onEvent(String json) {
        JSONObject msg;
        try {
            msg = new JSONObject(json);
        } catch (Exception e) {
            return;
        }
        String type = msg.optString("type");
        if ("turnEnd".equals(type)) {
            if (msg.optBoolean("child")) { return; }          // 别人派出去干活的子会话：结果会交回派它的那个会话
            if ("cancelled".equals(msg.optString("status"))) { return; }   // 自己停掉的那一轮不算跑完
            notifyEvent(msg.optString("sessionId"), msg.optString("name"), msg.optString("text"), "跑完了一轮");
        } else if ("askWaiting".equals(type)) {
            notifyEvent(msg.optString("sessionId"), msg.optString("name"), msg.optString("text"), "问你一道选择题");
        }
    }

    // ==================== 报活 ====================

    private void pingLoop() {
        while (running) {
            sleep(PING_MS);
            if (!running) { continue; }
            String target = base;
            if (target.isEmpty()) { continue; }
            post(target + "api?pageId=" + pageId, "{\"type\":\"channelPing\"}");
        }
    }

    private void post(String address, String body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(address).openConnection();
            conn.setConnectTimeout(8_000);
            conn.setReadTimeout(8_000);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            conn.getResponseCode();
        } catch (Exception e) {
            // 报活失败不要紧：连接真死了，读那头会超时，然后重连
        } finally {
            if (conn != null) { conn.disconnect(); }
        }
    }

    // ==================== 通知 ====================

    private void createChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ongoing = new NotificationChannel(
            CH_ONGOING, "一直连着", NotificationManager.IMPORTANCE_MIN);
        ongoing.setDescription("那条一直在后台连着的线。收起它会被系统掐掉，通知就收不到了。");
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);

        NotificationChannel events = new NotificationChannel(
            CH_EVENTS, "跑完一轮 / 在等你答", NotificationManager.IMPORTANCE_DEFAULT);
        events.setDescription("某个会话跑完一轮，或者模型在等你在某个会话里答一道选择题。");
        nm.createNotificationChannel(events);
    }

    /** 那条常驻的通知栏条目（低优先级：不响、不冒头，只是占一个位置）。 */
    private Notification ongoing(String text) {
        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Pi Chat 在后台连着")
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(tap)
            .build();
    }

    /** 换一下常驻通知上那句话（一样就不动它）。 */
    private void setOngoing(String text) {
        if (text.equals(ongoingText)) { return; }
        ongoingText = text;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(ONGOING_ID, ongoing(text));
    }

    /**
     * 弹一条"某个会话那边有事"的通知：标题是会话名，正文是那一轮回复的开头 / 那道题。
     * 人正看着 App 时不弹（就在眼前，弹了只是打扰）。
     *
     * 同一个会话的同类旧通知原地换掉（编号按"会话 + 事由"算），不堆一屏。
     */
    private void notifyEvent(String sessionId, String name, String text, String fallback) {
        if (MainActivity.visible) { return; }
        String body = text == null ? "" : text.trim();
        if (body.isEmpty()) { body = fallback; }
        String title = name == null || name.trim().isEmpty() ? "Pi Chat" : name.trim();
        boolean ask = "问你一道选择题".equals(fallback);

        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_SESSION, sessionId == null ? "" : sessionId);
        int requestCode = (sessionId + (ask ? "ask" : "turn")).hashCode();
        PendingIntent tap = PendingIntent.getActivity(this, requestCode, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification note = new Notification.Builder(this, CH_EVENTS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        NotificationManager nm = getSystemService(NotificationManager.class);
        int id = 1000 + Math.floorMod(requestCode, 100_000);
        nm.notify(id, note);
    }

    // ==================== 小工具 ====================

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            // 服务要停了 / 换地址了：赶紧把控制权交回去
        }
    }
}
