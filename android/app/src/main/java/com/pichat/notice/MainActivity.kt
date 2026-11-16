package com.pichat.notice

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * MainActivity —— app 的唯一一屏，两种画面：
 *
 * - 设置画面：一个地址输入框、一颗「打开」按钮、底下是用过的地址清单，再下面两行：
 *   「包里这份界面是不是最新的」（拿 APK 包里带的那份指纹跟后端现在发的比，见 checkBundledMedia）
 *   和「打包并安装新版」（叫电脑现打一个包、下下来装上，见 buildAndInstallApk）。
 *   点「打开」（或者点历史里的一条）就规范化地址、记下来、叫常驻服务重连、进网页看对话；
 *   打开过的地址自动记入清单（最新的排最上，最多留几条），每条边上有一颗 × 单独删。
 * - 网页画面：一个 WebView 装着后端的对话页面，点通知跳进来时直接带到那个会话上
 *   （`?session=<会话号>`，网页本来就认这个参数）。
 *
 * 收提醒不在这屏上干（那是 NoticeService 的事）：这屏退到后台 WebView 会被冻住，
 * 但常驻服务照旧连着、照旧弹通知。
 */
class MainActivity : Activity() {

    companion object {
        /** 通知点开时带的那个会话号。 */
        const val EXTRA_SESSION = "session"
        const val PREFS = "pichat"
        /** 现在用的那个地址。 */
        const val KEY_SERVER = "server"
        /** 打开过的地址（JSON 数组，最新的在前）。 */
        const val KEY_HISTORY = "history"
        /** 历史最多留几条（满了挤掉最老的）。 */
        private const val HISTORY_LIMIT = 8
        /** 连按两下返回才回设置：这两下的间隔上限（毫秒）。 */
        private const val BACK_TWICE_MS = 2000L
        /** 「包里这份界面是旧的」那行字的颜色（橙，不是报错那种红）。 */
        private const val STALE_COLOR = 0xFFB45309.toInt()
        /** 等电脑打包最多等多久（毫秒）：第一次装依赖会慢，但也不能一直等下去。 */
        private const val APK_BUILD_WAIT_MS = 20 * 60 * 1000
    }

    /** 上一回按返回键的时刻（SystemClock.uptimeMillis；0 = 眼下不算连按）。 */
    private var lastBackAt = 0L

    private lateinit var prefs: SharedPreferences
    private lateinit var settingsPanel: LinearLayout
    /** 装设置画面那一整列的外壳：手机上塞不下时能上下滚（包里界面那一行就不会被挤到屏幕外）。 */
    private lateinit var settingsScroll: ScrollView
    private lateinit var addressInput: EditText
    private lateinit var historyHeader: TextView
    private lateinit var historyList: LinearLayout
    private lateinit var bundleCheckText: TextView
    /** 「打包并安装新版」那颗按钮与它底下的那行进展。 */
    private lateinit var apkInstallButton: Button
    private lateinit var apkBuildText: TextView
    /** 这一轮「打包并安装」还在跑（跑的时候按钮置灰，免得点出第二份）。 */
    private var apkBusy = false
    private lateinit var webPanel: LinearLayout
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        buildUi()
        // 通知权限（Android 13 起要自己点头）：不给的话服务照连，只是不弹通知
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        // 服务常驻：app 一开就让它跑起来（改地址后它会自己重连）
        startForegroundService(Intent(this, NoticeService::class.java))
        handleIntent(intent)
    }

    /** 点通知跳进来（singleTask：不另开新屏）。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val session = intent.getStringExtra(EXTRA_SESSION)
        if (!session.isNullOrEmpty()) {
            openPage(session)
        }
    }

    // ------------------------------------------------------------------------
    // 界面（全是代码摆的，没有布局文件：就这一屏，不值得多一套资源）
    // ------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }

        // —— 设置画面 ——
        settingsPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(28))
        }
        settingsPanel.addView(TextView(this).apply {
            text = "Pi 提醒"
            textSize = 24f
            setPadding(0, 0, 0, dp(12))
        })
        settingsPanel.addView(TextView(this).apply {
            text = "填电脑上后端的地址（浏览器里打开的那个，比如 192.168.1.40:1867），点「打开」就连过去看对话。手机要跟电脑连同一个网络。"
            textSize = 14f
            setPadding(0, 0, 0, dp(12))
        })
        addressInput = EditText(this).apply {
            hint = "192.168.1.40:1867"
            setText(prefs.getString(KEY_SERVER, ""))
            setSingleLine(true)
        }
        settingsPanel.addView(addressInput)
        settingsPanel.addView(Button(this).apply {
            text = "打开"
            setOnClickListener { openAddress(addressInput.text.toString()) }
        })
        // 用过的地址：点一条就换那个地址打开；× 把那条从清单里删掉
        historyHeader = TextView(this).apply {
            text = "用过的地址"
            textSize = 14f
            setTextColor(Color.GRAY)
            setPadding(0, dp(16), 0, 0)
        }
        settingsPanel.addView(historyHeader)
        historyList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        settingsPanel.addView(historyList)
        // 包里带的那份界面是不是最新的：拿 APK 里那份指纹清单跟后端现在发的一比（见 checkBundledMedia）
        settingsPanel.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, dp(16), 0, 0)
            bundleCheckText = TextView(this@MainActivity).apply {
                text = "包里的界面：还没检查"
                textSize = 14f
                setTextColor(Color.GRAY)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            addView(bundleCheckText)
            addView(Button(this@MainActivity).apply {
                text = "检查"
                setOnClickListener { checkBundledMedia() }
            })
        })
        // 包旧了（或者 app 自己改过了）就叫电脑现打一个：打完自己下下来、交给系统安装器装上
        apkInstallButton = Button(this).apply {
            text = "打包并安装新版"
            setOnClickListener { buildAndInstallApk() }
        }
        settingsPanel.addView(apkInstallButton)
        apkBuildText = TextView(this).apply {
            text = "包旧了、或者电脑上改过 app 本身，就在这里点一下：电脑现打一个包，手机自动下载并弹安装。"
            textSize = 12f
            setTextColor(Color.GRAY)
        }
        settingsPanel.addView(apkBuildText)
        settingsPanel.addView(TextView(this).apply {
            text = "连接状态看通知栏那条常驻提示；收到的提醒要是没弹出来，\n" +
                "到系统的设置里把这个 app 的电池优化关掉（各品牌叫法不一，多在「省电」或「应用管理」里）。\n" +
                "看对话时连按两下返回键（或返回手势，两下不超过两秒）回到这一屏。"
            textSize = 12f
            setTextColor(Color.GRAY)
            setPadding(0, dp(16), 0, 0)
        })
        settingsScroll = ScrollView(this).apply {
            addView(settingsPanel)
        }
        root.addView(settingsScroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // —— 网页画面（默认收起来）——
        // 顶上不挂横条：手机上那一整条白占地方，回设置用系统的返回键 / 返回手势（见 onBackPressed）。
        webPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // 界面文件（各种 js / css）包里带着一份，第一次打开时不用从电脑上下（见 bundledMedia）
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): WebResourceResponse? = bundledMedia(request)
            }
        }
        webPanel.addView(web, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(webPanel, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        renderHistory()
        // 一进来就先对一次：包里那份界面旧没旧，不用人特意去点
        checkBundledMedia()
    }

    /** 把「用过的地址」那一节重摆一遍（刚打开、打开了一个新地址、删了一条时都叫它）。 */
    private fun renderHistory() {
        historyList.removeAllViews()
        val items = history()
        historyHeader.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        historyList.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        val current = savedAddress()
        for (address in items) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }
            row.addView(TextView(this).apply {
                text = address
                textSize = 15f
                typeface = if (address == current) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                setPadding(0, dp(12), 0, dp(12))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                // 整行都能点：换那个地址打开
                setOnClickListener { openAddress(address) }
            })
            row.addView(TextView(this).apply {
                text = "×"
                textSize = 20f
                setTextColor(Color.GRAY)
                setPadding(dp(16), dp(12), 0, dp(12))
                setOnClickListener {
                    forget(address)
                    renderHistory()
                }
            })
            historyList.addView(row)
        }
    }

    // ------------------------------------------------------------------------
    // 地址（输入框那一格 + 用过的地址清单）
    // ------------------------------------------------------------------------

    /**
     * 用一个地址打开对话：规范化、记进清单、叫服务重连、切到网页画面。
     * 输入框里的、历史清单里点来的，都走这一条。
     */
    private fun openAddress(raw: String) {
        val normalized = normalize(raw)
        if (normalized == null) {
            Toast.makeText(this, "地址不像话：填个「主机:端口」，或者带上 http:// 开头", Toast.LENGTH_LONG).show()
            return
        }
        addressInput.setText(normalized)
        remember(normalized)
        renderHistory()
        startService(Intent(this, NoticeService::class.java).apply {
            action = NoticeService.ACTION_RECONNECT
        })
        openPage(null)
    }

    /**
     * 规范化地址：只留「协议://主机:端口」。带不带 http:// 都认（没写就当 http），
     * 末尾的斜杠去掉。不成样子给 null。
     */
    private fun normalize(raw: String): String? {
        var text = raw.trim()
        if (text.isEmpty()) { return null }
        val scheme = when {
            text.startsWith("http://", ignoreCase = true) -> { text = text.substring(7); "http" }
            text.startsWith("https://", ignoreCase = true) -> { text = text.substring(8); "https" }
            else -> "http"
        }
        text = text.trimEnd('/').trim()
        if (text.isEmpty() || text.contains('/') || text.contains('?') || text.contains('#')) { return null }
        return "$scheme://$text"
    }

    /** 现在存着的地址（没填过给 null）。 */
    private fun savedAddress(): String? =
        prefs.getString(KEY_SERVER, null)?.takeIf { it.isNotBlank() }

    /** 用过的地址（最新的在最前）。 */
    private fun history(): List<String> {
        val raw = prefs.getString(KEY_HISTORY, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).map { array.optString(it) }.filter { it.isNotBlank() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** 记下一个打开过的地址：去重、排到最前、挤掉太老的；它同时就是现在用的地址。 */
    private fun remember(address: String) {
        val rest = history().filter { it != address }
        val list = (listOf(address) + rest).take(HISTORY_LIMIT)
        prefs.edit()
            .putString(KEY_SERVER, address)
            .putString(KEY_HISTORY, JSONArray(list).toString())
            .apply()
    }

    /** 从清单里删掉一条（现在连着的那个地址不跟着动：删记录不掐连接）。 */
    private fun forget(address: String) {
        val list = history().filter { it != address }
        prefs.edit().putString(KEY_HISTORY, JSONArray(list).toString()).apply()
    }

    // ------------------------------------------------------------------------
    // 两种画面之间切
    // ------------------------------------------------------------------------

    /** 切到网页画面并加载。session 给了就带上参数，让网页直接切到那个会话。 */
    private fun openPage(session: String?) {
        val base = savedAddress()
        if (base == null) {
            Toast.makeText(this, "先填后端地址", Toast.LENGTH_SHORT).show()
            return
        }
        var url = "$base/"
        if (!session.isNullOrEmpty()) {
            url += "?session=" + URLEncoder.encode(session, "UTF-8")
        }
        settingsScroll.visibility = View.GONE
        webPanel.visibility = View.VISIBLE
        lastBackAt = 0L
        web.loadUrl(url)
    }

    /** 回到设置画面（网页那层收起来，加载着的页面停掉）。 */
    private fun showSettings() {
        web.stopLoading()
        web.loadUrl("about:blank")
        webPanel.visibility = View.GONE
        settingsScroll.visibility = View.VISIBLE
        // 回到这一屏就对一次包里那份界面旧没旧
        checkBundledMedia()
    }

    /**
     * 返回键：网页画面时要连按两下才回设置，不退出 app。
     * 只按一下容易误触（手一滑就离开对话、网页还被清掉了），所以第一下只提一句。
     */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webPanel.visibility != View.VISIBLE) {
            super.onBackPressed()
            return
        }
        val now = SystemClock.uptimeMillis()
        if (lastBackAt != 0L && now - lastBackAt <= BACK_TWICE_MS) {
            lastBackAt = 0L
            showSettings()
            return
        }
        lastBackAt = now
        Toast.makeText(this, "再按一次回设置", Toast.LENGTH_SHORT).show()
    }

    // ------------------------------------------------------------------------
    // 包里这份界面旧没旧
    // ------------------------------------------------------------------------

    /**
     * 拿包里带着的那份界面指纹（assets/media-manifest.json）跟后端现在发的一比：
     * 对得上就是「包里这份就是电脑上现在用的」；对不上就把新的 APK 打一个装上。
     *
     * 两边问的是后端那条 `GET /media-manifest.json`（就是电脑上 media/ 里那几份 js / css
     * 此刻的指纹，跟页面地址里的 `?v=` 同一套算法），形状跟包里那份一样。
     * 只比界面文件：app 自己的改动（通知、返回键这些）不在这份清单里，那种只能看仓库里改没改。
     */
    private fun checkBundledMedia() {
        val base = savedAddress()
        if (base == null) {
            showBundleCheck(null, "还没填后端地址")
            return
        }
        bundleCheckText.text = "包里的界面：检查中…"
        bundleCheckText.setTextColor(Color.GRAY)
        bundleCheckClient.newCall(Request.Builder().url("$base/media-manifest.json").build())
            .enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    onMain { showBundleCheck(null, "连不上 $base") }
                }

                override fun onResponse(call: Call, response: Response) {
                    val code = response.code
                    val remote = response.use {
                        if (!it.isSuccessful) { return@use null }
                        try {
                            val json = JSONObject(it.body!!.string())
                            json.keys().asSequence().associateWith { key -> json.optString(key) }
                        } catch (_: Exception) {
                            null
                        }
                    }
                    onMain {
                        showBundleCheck(remote, if (remote == null) "后端没给这份清单（HTTP $code）" else "")
                    }
                }
            })
    }

    /**
     * 把那一行的结论摆上去。remote 是后端那份清单（文件名 → 指纹），取不到给 null 并说明原因。
     * 两边对不上的文件名一个都不漏（后端新加了、包里没有的也算旧的，那同样是该重打一个包）。
     */
    private fun showBundleCheck(remote: Map<String, String>?, reason: String) {
        if (remote == null) {
            bundleCheckText.text = "包里的界面：没查成（$reason）"
            bundleCheckText.setTextColor(Color.GRAY)
            return
        }
        val bundled = bundledHashes()
        val stale = (remote.keys + bundled.keys).filter { remote[it] != bundled[it] }.sorted()
        if (stale.isEmpty()) {
            bundleCheckText.text = "包里的界面：跟电脑上的一致"
            bundleCheckText.setTextColor(Color.GRAY)
        } else {
            bundleCheckText.text = "包里的界面是旧的（${stale.joinToString("、")}），重打一个 APK 装上"
            bundleCheckText.setTextColor(STALE_COLOR)
        }
    }

    /** 后台那一头回来时回主线程改界面（这屏已经没了就别动了）。 */
    private fun onMain(block: () -> Unit) {
        if (isDestroyed || isFinishing) { return }
        runOnUiThread { if (!isDestroyed && !isFinishing) { block() } }
    }

    // ------------------------------------------------------------------------
    // 打包并安装新版
    // ------------------------------------------------------------------------

    /**
     * 「打包并安装新版」：叫电脑现打一个包 → 隔一会儿问一次打好没 → 下下来 → 交给系统安装器。
     *
     * 为什么得在电脑上打：界面文件（`media/` 那几份）是打包那一刻从电脑上拷进 APK 的，
     * 手机手边没有它们。三条口都在后端那边：`POST /apk/build`（开始）、`GET /apk/build`
     * （进度）、`GET /apk`（把包发过来），见 src/apkBuild.ts。
     *
     * 整串在后台线程里跑（打包要几十秒到几分钟），界面上只换那行字；
     * 正在跑的时候再点不会再起一份（gradle 两个进程同时写一个 build 目录会互相踩）。
     */
    private fun buildAndInstallApk() {
        val base = savedAddress()
        if (base == null) {
            Toast.makeText(this, "先填后端地址", Toast.LENGTH_SHORT).show()
            return
        }
        if (apkBusy) { return }
        apkBusy = true
        syncApkControls()
        showApkNote("正在叫电脑打包…")
        Thread {
            try {
                runApkBuild(base)
            } catch (error: Exception) {
                showApkNote("没成：${error.message ?: error.javaClass.simpleName}")
            } finally {
                apkBusy = false
                onMain { syncApkControls() }
            }
        }.apply {
            name = "pichat-apk"
            start()
        }
    }

    /** 后台线程里那一串：开始 → 等 → 下载 → 交给系统安装。出错就抛出去，上面那层写一行字。 */
    private fun runApkBuild(base: String) {
        var status = apkRequest(Request.Builder().url("$base/apk/build").post(emptyBody).build())
        if (!status.optBoolean("canBuild")) {
            showApkNote("这台电脑上编不了：${status.optString("reason")}")
            return
        }
        // 打包要一会儿：隔一秒半问一次（后端正在打的话再 POST 只会回报当前进度）
        var waited = 0L
        while (status.optString("state") == "running") {
            showApkNote("正在打包… ${status.optInt("seconds")} 秒")
            if (waited >= APK_BUILD_WAIT_MS) {
                showApkNote("等太久了，先不等了（电脑上可能还在打，过会儿再点一下看看）")
                return
            }
            Thread.sleep(1500)
            waited += 1500
            status = apkRequest(Request.Builder().url("$base/apk/build").build())
        }
        val state = status.optString("state")
        if (state == "failed") {
            val tail = status.optString("log").lines().lastOrNull { it.isNotBlank() } ?: ""
            showApkNote("没打成：${status.optString("error")}${if (tail.isEmpty()) "" else "\n" + tail}")
            return
        }
        if (status.isNull("apk")) {
            showApkNote("打完了但手边没有包（这台电脑上是第一次打包？）")
            return
        }
        downloadAndInstallApk(base)
    }

    /** 把编好的包拉下来，一边拉一边写进系统安装会话（不落磁盘：省得留一份装完没用的文件）。 */
    private fun downloadAndInstallApk(base: String) {
        apkClient.newCall(Request.Builder().url("$base/apk").build()).execute().use { response ->
            if (!response.isSuccessful) {
                showApkNote("拿不到包：HTTP ${response.code}" + if (response.code == 404) "（电脑上还没打好）" else "")
                return
            }
            val body = response.body
            val size = body?.contentLength() ?: -1L
            if (body == null || size <= 0) {
                showApkNote("拿到的包没写多大（Content-Length 没有），装不了")
                return
            }
            showApkNote("正在下载新版（${(size + 1024 * 1024 - 1) / (1024 * 1024)} MB）…")
            installFromStream(body.byteStream(), size)
        }
    }

    /** 把流里的字节写进一次安装会话，然后让系统弹那张「安装」确认框（回话落到 ApkInstallReceiver）。 */
    private fun installFromStream(input: InputStream, size: Long) {
        if (!packageManager.canRequestPackageInstalls()) {
            onMain {
                showApkNote("得先在系统里允许这个 app「安装未知应用」，回来再点一次")
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:$packageName")))
                } catch (_: Exception) {
                    Toast.makeText(this, "到系统设置里找「安装未知应用」", Toast.LENGTH_LONG).show()
                }
            }
            return
        }
        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            input.use { source ->
                session.openWrite("pi-chat.apk", 0, size).use { sink ->
                    source.copyTo(sink)
                    session.fsync(sink)
                }
            }
        } catch (error: Exception) {
            session.abandon()
            throw error
        }
        // 系统答话的 PendingIntent：API 31 起要写明可变/不可变。
        // 这里得可变 —— 那条消息里的状态和原因都是系统写进去的（EXTRA_STATUS 这些）。
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val done = PendingIntent.getBroadcast(this, sessionId,
            Intent(this, ApkInstallReceiver::class.java), flags)
        session.commit(done.intentSender)
        session.close()
        showApkNote("下好了，等系统那张安装确认框…")
    }

    /** 问一句后端那三条口（/apk/build），回来的 JSON 原样给调用方。 */
    private fun apkRequest(request: Request): JSONObject {
        apkClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException(if (response.code == 404) "这台电脑上的后端还没有这一条（插件旧了？）" else "HTTP ${response.code}")
            }
            val text = response.body?.string() ?: "{}"
            return JSONObject(text)
        }
    }

    /** 换那行进展（后台线程叫的，自己负责回主线程）。 */
    private fun showApkNote(text: String) {
        onMain { apkBuildText.text = text }
    }

    /** 按钮的字与能不能点跟着「正在跑」走。 */
    private fun syncApkControls() {
        apkInstallButton.isEnabled = !apkBusy
        apkInstallButton.text = if (apkBusy) "正在打包…" else "打包并安装新版"
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    // ------------------------------------------------------------------------
    // 界面文件：包里那份（assets/media/，由 app/build.gradle 的 bundleMedia 生成）
    // ------------------------------------------------------------------------

    /** 查一次界面清单用的客户端（几 KB 的一个请求，5 秒还没答就当连不上）。 */
    private val bundleCheckClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    /** 打包、下载包用的客户端：下载那一下得等几十秒（2 MB 多），读超时放宽。 */
    private val apkClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    /** 「开始打包」那条 POST 没有请求体。 */
    private val emptyBody = ByteArray(0).toRequestBody()

    /** 包里的界面文件各自的内容指纹（assets/media-manifest.json）。读一次就留着。读不到就是空表。 */
    private var bundledHashesCache: Map<String, String>? = null

    /**
     * 拦下 `/media/xxx?v=指纹`：包里那份的指纹跟地址上的对得上，就直接把包里的读出来给网页，
     * 一个字节都不走网络。对不上（没带指纹、插件升级过了、包里没有这个文件）返回 null，
     * 照旧走网络 —— 手机上永远不会看到跟电脑上不一样的旧界面。
     *
     * 这条只在第一次打开时省那 600 KB 上下；之后的打开本来就有网页缓存。
     * 这里不算 gzip：包里的字节是磁盘上现成的，读出来就发，压一遍反倒多花时间。
     */
    private fun bundledMedia(request: WebResourceRequest?): WebResourceResponse? {
        val url = request?.url ?: return null
        val path = url.path ?: return null
        if (!path.startsWith("/media/")) { return null }
        val name = path.substring("/media/".length)
        if (name.isEmpty() || name.contains('/')) { return null }
        val want = url.getQueryParameter("v") ?: return null
        if (bundledHashes()[name] != want) { return null }
        val bytes = try {
            assets.open("media/$name").use { it.readBytes() }
        } catch (_: Exception) {
            return null
        }
        val mime = when {
            name.endsWith(".css", ignoreCase = true) -> "text/css"
            name.endsWith(".js", ignoreCase = true) -> "application/javascript"
            else -> return null
        }
        return WebResourceResponse(
            mime, "utf-8", 200, "OK",
            mapOf("Cache-Control" to "public, max-age=31536000, immutable"),
            ByteArrayInputStream(bytes),
        )
    }

    private fun bundledHashes(): Map<String, String> {
        bundledHashesCache?.let { return it }
        val map = try {
            val text = assets.open("media-manifest.json").use {
                it.readBytes().toString(Charsets.UTF_8)
            }
            val json = JSONObject(text)
            json.keys().asSequence().associateWith { key -> json.optString(key) }
        } catch (_: Exception) {
            emptyMap()
        }
        bundledHashesCache = map
        return map
    }
}
