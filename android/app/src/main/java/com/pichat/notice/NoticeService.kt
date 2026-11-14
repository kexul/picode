package com.pichat.notice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.pichat.notice.MainActivity.Companion.KEY_SERVER
import com.pichat.notice.MainActivity.Companion.PREFS
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * NoticeService —— 常驻的小服务，管两件事：
 *
 * 1. 状态栏挂一条不消失的通知（连着 / 断了 / 重试中），人也从这条看连接状态；
 * 2. 连着后端的提醒流（`GET /phone-notice`，SSE），收到「有事」就弹一条系统通知，
 *    收到「收掉」就把对应那条撤下来。
 *
 * 连接是自己的线程上同步跑的：断了按退避（2 秒起、翻倍、封顶 1 分钟）重连，
 * 重连时重新读一遍设置里的地址（改完地址不用重启 app，主界面点「保存并重连」就行）。
 *
 * 为什么不嵌进主界面：WebView 在后台会被冻住，冻住了就收不到提醒；系统通知必须由
 * 前台服务来发。所以看对话是主界面的事，收提醒是这个服务的事，两不耽误。
 */
class NoticeService : Service() {

    companion object {
        /** 主界面改完地址叫这边重连的动作名。 */
        const val ACTION_RECONNECT = "com.pichat.notice.RECONNECT"
        const val CHANNEL_STATUS = "status"
        const val CHANNEL_NOTICES = "notices"
        /** 状态那条常驻通知的编号。 */
        private const val STATUS_ID = 1
        /** 会话提醒那批通知的标签（编号用会话号的 hash）。 */
        private const val TAG_NOTICE = "notice"
        /** 通知正文最多留多少字（SSE 推来的最长 1200，通知栏显示不下）。 */
        private const val BODY_CHARS = 280
    }

    @Volatile
    private var running = false
    private var loopThread: Thread? = null
    /** 正在跑的那次请求（换地址重连时用它掐断，循环就会重新读地址）。 */
    @Volatile
    private var call: Call? = null

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // SSE 是长连接：读不等超时，活着没活着靠后端的心跳与 TCP 断开来报
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // minSdk 26：通知渠道直接建，不用分版本
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, "连接状态", NotificationManager.IMPORTANCE_MIN).apply {
                description = "跟后端连着没有的常驻提示（不出声、不弹横幅）"
                setShowBadge(false)
            })
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_NOTICES, "会话提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "会话跑完一轮、等你答题时的提醒"
            })
        // 先把常驻那条挂上去（前台服务的要求），内容马上会被循环里的第一条状态盖掉
        startForeground(STATUS_ID, statusNote("正在启动…"))
        running = true
        loopThread = Thread { loop() }.apply {
            name = "pichat-notice-sse"
            start()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RECONNECT) {
            // 掐断当前连接：循环那头收到失败就会重新读地址、重新连
            try { call?.cancel() } catch (_: Exception) { /* 已经断了 */ }
        }
        // 服务被系统收走后尽量拉回来
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        try { call?.cancel() } catch (_: Exception) { /* 已经断了 */ }
        loopThread = null
        super.onDestroy()
    }

    /** 设置文件里存的后端地址（主界面填的），没填过给 null。 */
    private fun savedAddress(): String? {
        val value = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null)
        return value?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** 连接循环：连 → 收 → 断了等一等 → 再连，一直转到服务被停。 */
    private fun loop() {
        var backoffMs = 2_000L
        while (running) {
            val base = savedAddress()
            if (base == null) {
                updateStatus("还没填后端地址，打开 app 填一个")
                quietSleep(5_000)
                continue
            }
            try {
                updateStatus("连接中… $base")
                val request = Request.Builder().url("$base/phone-notice").build()
                val call = client.newCall(request).also { this.call = it }
                call.execute().use { response ->
                    if (!response.isSuccessful) { throw IOException("HTTP ${response.code}") }
                    updateStatus("已连接 $base")
                    // 连上了：退避从头算
                    backoffMs = 2_000L
                    val reader = response.body!!.byteStream().bufferedReader(Charsets.UTF_8)
                    var data: String? = null
                    // SSE 一行一行读：data 行攒着，空行就是一条事件到齐了
                    while (running) {
                        val line = reader.readLine() ?: throw IOException("连接断了")
                        when {
                            line.startsWith("data:") -> data = line.substring(5).trim()
                            line.startsWith("event:") || line.startsWith("retry:") || line.startsWith(":") -> { /* 事件名与注释，不用管 */ }
                            line.isEmpty() -> {
                                data?.let { handle(it) }
                                data = null
                            }
                        }
                    }
                    throw IOException("服务停了")
                }
            } catch (error: Exception) {
                if (!running) { break }
                updateStatus("断开，${backoffMs / 1000} 秒后重试（${error.message ?: ""}）")
            }
            quietSleep(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(60_000)
        }
    }

    /** 一条事件到齐了：认出是「有事」还是「收掉」，别的（hello、tick）不管。 */
    private fun handle(data: String) {
        val message = try { JSONObject(data) } catch (_: Exception) { return }
        when (message.optString("type")) {
            "notice" -> showNotice(message)
            "close" -> {
                val sessionId = message.optString("sessionId")
                if (sessionId.isNotEmpty()) {
                    getSystemService(NotificationManager::class.java).cancel(TAG_NOTICE, sessionId.hashCode())
                }
            }
        }
    }

    /** 弹一条会话提醒：点开就进主界面看那个会话。 */
    private fun showNotice(message: JSONObject) {
        val sessionId = message.optString("sessionId")
        val name = message.optString("name").ifEmpty { "会话" }
        val ask = message.optString("kind") == "ask"
        // 通知栏是纯文本：markdown 原样塞进去会带一堆星号井号，压成一行再截短
        val body = message.optString("text")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(BODY_CHARS)
        val open = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(MainActivity.EXTRA_SESSION, sessionId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pending = PendingIntent.getActivity(
            this, sessionId.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = (if (ask) "等你答一句 · " else "跑完一轮 · ") + name
        val text = body.ifEmpty { title }
        val notification = Notification.Builder(this, CHANNEL_NOTICES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        // 编号用会话号的 hash：同一个会话的提醒换掉旧的，不同会话各占一条
        getSystemService(NotificationManager::class.java)
            .notify(TAG_NOTICE, sessionId.hashCode(), notification)
    }

    /** 刷新状态栏那条常驻通知（连通、断开、重试中）。 */
    private fun updateStatus(text: String) {
        val open = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        getSystemService(NotificationManager::class.java)
            .notify(STATUS_ID, statusNote(text).apply { contentIntent = pending })
    }

    private fun statusNote(text: String): Notification =
        Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Pi 提醒")
            .setContentText(text)
            .setOngoing(true)
            .build()

    private fun quietSleep(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) { /* 停了就当睡到头 */ }
    }
}
