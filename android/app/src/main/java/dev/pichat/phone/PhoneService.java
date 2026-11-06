package dev.pichat.phone;

import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;

/**
 * 收提醒的那颗服务：前台常驻，里面挂着一条到后端的连接（GET /phone，一行一段地往后写）。
 *
 * 后端把「现在有哪些会话、每个会话留着的那几条」和之后每一条「有事」都推到这条连接上：
 * 存进 Store 给两个界面看，跑完一轮 / 在等你答一句的再弹一条系统通知。
 * 断了就自己重连（2 秒起、最长 60 秒一次）——手机换网、进电梯、后端重启都照这个走；
 * 后端明说「停了」（end）就不再自己重连，等人在列表上点那颗「重新连」。
 *
 * 为什么要常驻：安卓不会给普通后台进程留长连接，进了后台迟早被掐掉；挂一条常驻通知
 * 才留得住（代价是通知栏里一直有一条）。这条连接上漏掉的就是漏掉了，不补发：
 * 手机上少一条提醒不算事，点开 app 看会话就全都在。
 */
public class PhoneService extends Service {
    static final String ACTION_START = "dev.pichat.phone.START";

    private static final String TAG = "pichat-phone";

    /** 现在连到哪儿了（界面上那行小字就是它）。 */
    private static volatile String status = "还没开始";
    /** 眼下这颗服务（界面上那颗「重新连」要戳它一下）。 */
    private static volatile PhoneService current;

    static String status() { return status; }

    /** 把服务挂起来（存好地址、开机自启都走这条）。一直挂着：手机上没地方关它。 */
    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, PhoneService.class).setAction(ACTION_START));
    }

    /**
     * 界面上那颗「重新连」：把手上那条连接掐掉，让它马上重新连；
     * 服务已经收摊了（后端说过 end）就重新支起来。
     */
    static void reconnect(Context ctx) {
        PhoneService svc = current;
        if (svc != null) {
            svc.stopped = false;
            svc.dropLink();
            if (svc.worker == null || !svc.worker.isAlive()) {
                svc.running = true;
                svc.startWorker();
            }
        }
        start(ctx);
    }

    private volatile boolean running;
    /** 后端说了「停了」：别再自己重连（等人点「重新连」）。 */
    private volatile boolean stopped;
    private volatile HttpURLConnection conn;
    private Thread worker;
    /** 连着失败几次：决定下一次隔多久再连。 */
    private int failures;
    /** 常驻通知上现在写的那句（一样就不重画）。 */
    private String shown = "";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        current = this;
        Notifier.ensureChannels(this);
        startForeground(Notifier.SERVICE_ID, Notifier.service(this, "连接中…"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 地址还没有：不该挂在这儿（开机自启、系统把它拉起来时都可能碰上）
        if (Settings.baseUrl(this).isEmpty()) { stopSelf(); return START_NOT_STICKY; }
        if (worker == null || !worker.isAlive()) {
            stopped = false;
            running = true;
            startWorker();
        }
        return START_STICKY;
    }

    private void startWorker() {
        worker = new Thread(this::loop, "phone-link");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (current == this) { current = null; }
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        super.onDestroy();
    }

    /** 把守着的那条连接掐掉：读的那头会立刻醒过来，回到 loop 里重连。 */
    private void dropLink() {
        HttpURLConnection c = conn;
        if (c == null) { return; }
        try {
            c.disconnect();
        } catch (Exception ignored) {
            // 已经断了
        }
    }

    /** 一直连着，断了就重连（退出条件是 running 变 false / 后端说了 end）。 */
    private void loop() {
        while (running && !stopped) {
            String base = Settings.baseUrl(this);
            if (base.isEmpty()) {
                say("还没填后端地址");
                sleep(5000);
                continue;
            }
            boolean hello = connectOnce(base);
            if (!running || stopped) { return; }
            if (hello) { failures = 0; } else { failures = Math.min(failures + 1, 5); }
            // 连上过（刚断的）：两秒后就再试；一直连不上：越退越远，最多一分钟一次
            sleep(hello ? 2000L : Math.min(60000L, 2000L << failures));
        }
    }

    /**
     * 连一次，读到断为止。
     * @returns 这次连上过没有（收到过后端的 hello）
     */
    private boolean connectOnce(String base) {
        HttpURLConnection c = null;
        boolean hello = false;
        say(failures == 0 ? "正在连…" : "重连中…");
        try {
            URL url = new URL(base + "/phone?client=" + Settings.clientId(this));
            c = (HttpURLConnection) url.openConnection();
            conn = c;
            c.setRequestProperty("Accept", "text/event-stream");
            c.setRequestProperty("Cache-Control", "no-store");
            c.setConnectTimeout(15000);
            // 后端每 25 秒写一下心跳：这么久一点动静都没有，就是这条连接已经死了
            c.setReadTimeout(90000);
            int code = c.getResponseCode();
            if (code != 200) {
                say("后端没认（HTTP " + code + "）");
                return false;
            }
            say("已连上");
            BufferedReader reader = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String event = "";
            StringBuilder data = new StringBuilder();
            String line;
            while (running && !stopped && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (handle(event, data.toString())) { hello = true; }
                    event = "";
                    data.setLength(0);
                    continue;
                }
                if (line.charAt(0) == ':') { continue; }          // 注释 / 心跳前的空话
                int colon = line.indexOf(':');
                String field = colon < 0 ? line : line.substring(0, colon);
                String value = colon < 0 ? "" : line.substring(colon + 1);
                if (value.startsWith(" ")) { value = value.substring(1); }
                if ("event".equals(field)) {
                    event = value;
                } else if ("data".equals(field)) {
                    if (data.length() > 0) { data.append('\n'); }
                    data.append(value);
                }
            }
            if (running && !stopped) { say("连接断了，重连中…"); }
        } catch (SocketTimeoutException e) {
            if (running && !stopped) { say("好一阵没动静了，重连中…"); }
        } catch (ConnectException e) {
            if (running && !stopped) { say("连不上后端，重连中…"); }
        } catch (UnknownHostException e) {
            if (running && !stopped) { say("地址找不到，重连中…"); }
        } catch (Exception e) {
            if (running && !stopped) { say("重连中…（" + brief(e) + "）"); }
        } finally {
            if (conn == c) { conn = null; }
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                    // 已经断了
                }
            }
        }
        return hello;
    }

    /**
     * 收到一段（空行收尾的那个事件）。
     * @returns 是不是 hello（说明这趟真连上了）
     */
    private boolean handle(String event, String data) {
        if ("hello".equals(event)) { return true; }
        if ("end".equals(event)) {
            // 后端明说停了（换端口重启、人在菜单里退出）：过一会儿再试。
            // 不放弃重连：那边很快就回来的时候多，手机不该坐着等人去点。
            say("后端停了，重连中…");
            return false;
        }
        if ("tick".equals(event) || event.isEmpty()) { return false; }
        if ("askdone".equals(event)) {
            // 某道题已经答过了（在网页上、或者另一台设备上答的）：把那几个选项置灰
            try {
                Store.markAnswered(new JSONObject(data).optString("cardId", ""));
            } catch (Exception ignored) {
                // 读不懂就算了，不影响别的
            }
            return false;
        }
        // snapshot / sessions / note 都交给 Store 存着，两个界面照着它画
        Store.onEvent(event, data);
        if ("note".equals(event)) { notifyNote(data); }
        return false;
    }

    /** 新的一条通知：跑完一轮、在等你答一句才弹；自己刚说的那句和正在看的那个会话都不弹。 */
    private void notifyNote(String data) {
        try {
            JSONObject note = new JSONObject(data);
            String kind = note.optString("kind", "done");
            if (!"done".equals(kind) && !"ask".equals(kind)) { return; }
            Notifier.postNote(this,
                note.optString("name", "会话"),
                note.optString("text", ""),
                kind,
                note.optString("sessionId", ""),
                note.optString("from", ""),
                note.optLong("at", 0));
        } catch (Exception e) {
            Log.w(TAG, "这条提醒读不懂：" + data);
        }
    }

    /** 换一下“现在连到哪儿了”那句话（常驻通知 + 界面上那行小字都看它）。 */
    private void say(String text) {
        status = text;
        if (text.equals(shown)) { return; }
        shown = text;
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) { nm.notify(Notifier.SERVICE_ID, Notifier.service(this, text)); }
        } catch (Exception e) {
            Log.w(TAG, "常驻通知没换成：" + brief(e));
        }
    }

    private static String brief(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
