package com.pichat.notice

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
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
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
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
import java.io.OutputStream
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * MainActivity —— app 的唯一一屏，两种画面：
 *
 * - 设置画面：一张「连到哪台电脑」的清单 —— 一行一台连过的电脑，点一行只是选中它、
 *   顺手查一下那台的界面文件旧没旧（右边出勾 / 一颗向下箭头，见 checkBundledMedia），
 *   点底下那颗「打开」才真连过去；长按一行把它从清单里删掉。
 *   清单底下「＋ 另一台电脑」才展开填地址那一行（回车＝打开）；一台都没连过时那一行就直接摆着。
 *   界面对不上时，那一行右边的向下箭头就是「现打一个包装上」（见 buildAndInstallApk）。
 * - 网页画面：一个 WebView 装着后端的对话页面，点通知跳进来时直接带到那个会话上
 *   （页面已经在就只在页面里切一格，见 openPage）。
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
        /** 能点的字（「另一台电脑」、选中的那个圆点）的颜色。 */
        private const val ACCENT_COLOR = 0xFF00796B.toInt()
        /** 一致的勾。 */
        private const val OK_COLOR = 0xFF1B8A3F.toInt()
        /** 不当眼的字：标题上头那行小字、「打包并安装新版」平时就这样。 */
        private const val QUIET_COLOR = 0xFF607D8B.toInt()
        /** 还没选中的那个圆点、以及灰着的字。 */
        private const val DIM_COLOR = 0xFFB0BEC5.toInt()
        /** 清单行与行之间那条细线的颜色。 */
        private const val DIVIDER_COLOR = 0xFFECEFF1.toInt()
        /** 等电脑打包最多等多久（毫秒）：第一次装依赖会慢，但也不能一直等下去。 */
        private const val APK_BUILD_WAIT_MS = 20 * 60 * 1000
        /** 下载最多试几次（含第一次）：断了停一会儿，从已经下到的那个字节接着要。 */
        private const val APK_DOWNLOAD_TRIES = 5
        /** 每断一回先停多久（毫秒）：第一次重试停这么久，之后一次次加长。 */
        private const val APK_RETRY_WAIT_MS = 1500L
    }

    /** 清单里每一行右边那块结论是这么来的：拿包里带的那份界面指纹，跟那台电脑现在发的比。 */
    private enum class BundleState { CHECKING, OK, STALE, UNKNOWN }

    /** 一次检查的结论：state 决定右边画勾还是画下载按钮，detail 是没查成的原因 / 对不上的文件名。 */
    private class BundleResult(val state: BundleState, val detail: String = "")

    /** 上一回按返回键的时刻（SystemClock.uptimeMillis；0 = 眼下不算连按）。 */
    private var lastBackAt = 0L

    private lateinit var prefs: SharedPreferences
    private lateinit var settingsPanel: LinearLayout
    /** 装设置画面那一整列的外壳：手机上塞不下时能上下滚（清单长了不会被挤到屏幕外）。 */
    private lateinit var settingsScroll: ScrollView
    private lateinit var sectionTitle: TextView
    /** 填新地址那一行（平时收着）与它里面的输入框。 */
    private lateinit var addressRow: LinearLayout
    private lateinit var addressInput: EditText
    /** 连过的电脑那一张清单、清单底下的「＋ 另一台电脑」、以及底下那颗「打开」。 */
    private lateinit var listBox: LinearLayout
    private lateinit var addRow: LinearLayout
    private lateinit var openSelectedButton: Button
    /** 现在选中的那台（null = 清单是空的）。 */
    private var selectedAddress: String? = null
    /** 每台查过的结论（地址 → 结论）：重摆清单时照这个画右边的勾 / 下载按钮。 */
    private val bundleResults = mutableMapOf<String, BundleResult>()
    /** 打包 / 下载时那行进展字，以及那根横条。 */
    private lateinit var apkBuildText: TextView
    private lateinit var apkProgress: ProgressBar
    /** 这一轮「打包并安装」还在跑（跑的时候那颗箭头换成「…」，免得点出第二份）。 */
    private var apkBusy = false
    private lateinit var webPanel: LinearLayout
    private lateinit var web: WebView
    /** 网页里现在装着哪个地址（null = 还没有 / 已经清成 about:blank，见 openPage 与 showSettings）。 */
    private var loadedBase: String? = null

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
        // 平时就一张「连到哪台电脑」的清单：点一行只换选中、顺手查那台的界面旧没旧，
        // 点底下那颗「打开」才真连过去（见 renderSettings）。
        settingsPanel.addView(TextView(this).apply {
            text = "Pi Chat"
            textSize = 22f
        })
        sectionTitle = TextView(this).apply {
            text = "连到哪台电脑"
            textSize = 13f
            setTextColor(QUIET_COLOR)
            setPadding(0, dp(14), 0, 0)
        }
        settingsPanel.addView(sectionTitle)

        // 填一个没连过的地址：点清单底下「＋ 另一台电脑」才展开。
        // 一台都还没连过的时候直接就摆着，省得先去找那颗「另一台电脑」。
        addressRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
        }
        addressInput = EditText(this).apply {
            hint = "192.168.1.40:1867"
            setSingleLine(true)
            // 网址那种键盘：不自动大写、不按句子联想
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            // 键盘右下角那颗「前往」就是「打开」：填完直接按，不用再挪手指上去点按钮。
            // 这一行是单行的地址，回车/前往都只有「打开」一个意思，所以不管报上来的是哪种动作都当它。
            setOnEditorActionListener { _, _, _ ->
                !addressInput.text.isBlank() && openAddress(addressInput.text.toString())
            }
        }
        addressRow.addView(addressInput)
        addressRow.addView(Button(this).apply {
            text = "打开"
            setOnClickListener { openAddress(addressInput.text.toString()) }
        })
        settingsPanel.addView(addressRow)

        listBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        settingsPanel.addView(listBox)
        addRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(14), 0, dp(14))
            setOnClickListener { showAddressRow(true) }
        }
        addRow.addView(TextView(this).apply {
            text = "＋"
            textSize = 17f
            setTextColor(ACCENT_COLOR)
            width = dp(28)
        })
        addRow.addView(TextView(this).apply {
            text = "另一台电脑"
            textSize = 15f
            setTextColor(ACCENT_COLOR)
        })
        settingsPanel.addView(addRow)
        // 真去连：连选中的那台
        openSelectedButton = Button(this).apply {
            text = "打开"
            setOnClickListener { selectedAddress?.let { openAddress(it) } }
        }
        settingsPanel.addView(openSelectedButton)
        // 进展那行字（打包、下载、出错都写这儿）与那条横条：平时都收着
        apkBuildText = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.GRAY)
            setPadding(0, dp(10), 0, 0)
            visibility = View.GONE
        }
        settingsPanel.addView(apkBuildText)
        // 跑起来时才有的一条横条：打包那段转圈（给不出百分比），下载那段按下了多少字节画
        apkProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            visibility = View.GONE
        }
        settingsPanel.addView(apkProgress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
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
        renderSettings()
        // 一进来就把选中那台对一次：界面旧没旧，不用人特意去点
        selectedAddress?.let { checkBundledMedia(it) }
    }

    /**
     * 把这一屏重摆一遍：清单每一行（圆点、地址、右边的结论）、底下那颗「打开」、
     * 填地址那一行来不来。选中变了、删了一条、从网页退回来、打包跑完都叫它。
     */
    private fun renderSettings() {
        val items = listAddresses()
        if (items.none { it == selectedAddress }) { selectedAddress = items.firstOrNull() }
        // 一台都没连过：直接把填地址那一行摆出来
        if (items.isEmpty()) { addressRow.visibility = View.VISIBLE }
        val typing = addressRow.visibility == View.VISIBLE

        sectionTitle.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        listBox.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        addRow.visibility = if (items.isEmpty() || typing) View.GONE else View.VISIBLE
        openSelectedButton.visibility = if (items.isEmpty() || typing) View.GONE else View.VISIBLE

        listBox.removeAllViews()
        val current = selectedAddress
        for (address in items) {
            val selected = address == current
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(14), 0, dp(14))
            }
            row.addView(TextView(this).apply {
                text = if (selected) "●" else "○"
                textSize = 16f
                setTextColor(if (selected) ACCENT_COLOR else DIM_COLOR)
                width = dp(28)
            })
            row.addView(TextView(this).apply {
                text = hostOf(address)
                textSize = 15f
                typeface = if (selected) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            row.addView(statusView(address))
            // 点一行 = 选它、顺手查它（界面文件旧没旧）；已经选中的再点一下就是重查
            row.setOnClickListener { selectAddress(address) }
            // 删一条藏得深一点：长按那行（点一下就删太容易误触）
            row.setOnLongClickListener {
                confirmForget(address)
                true
            }
            listBox.addView(row)
            listBox.addView(View(this).apply {
                setBackgroundColor(DIVIDER_COLOR)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1)
            })
        }
    }

    /** 清单里要摆的地址：用过的那些；一条都没记过但存着地址时（升级上来的老安装），把存着的摆上。 */
    private fun listAddresses(): List<String> {
        val items = history()
        if (items.isNotEmpty()) { return items }
        return listOfNotNull(savedAddress())
    }

    /** 清单里那台只写「主机:端口」：协议几乎总是 http，写出来只是多占地方。 */
    private fun hostOf(address: String): String =
        address.removePrefix("http://").removePrefix("https://")

    /**
     * 一行右边那块结论：一致是一颗绿勾；旧了就是一颗下载按钮（点一下就叫电脑现打一个、下下来装上）；
     * 正在查写「查…」，没查成写「没查成」。
     */
    private fun statusView(address: String): View {
        val result = bundleResults[address]
        return when (result?.state) {
            BundleState.STALE -> TextView(this).apply {
                text = if (apkBusy) "…" else "↓"
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setTextColor(STALE_COLOR)
                background = ring(0xFFFFF3E0.toInt(), 0xFFFFCC80.toInt())
                if (!apkBusy) { setOnClickListener { buildAndInstallApk(address) } }
                layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
            }
            BundleState.OK -> TextView(this).apply {
                text = "✓"
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(OK_COLOR)
                setPadding(dp(8), 0, dp(4), 0)
            }
            BundleState.CHECKING -> TextView(this).apply {
                text = "查…"
                textSize = 13f
                setTextColor(QUIET_COLOR)
                setPadding(dp(8), 0, dp(4), 0)
            }
            BundleState.UNKNOWN -> TextView(this).apply {
                text = "没查成"
                textSize = 12f
                setTextColor(DIM_COLOR)
                setPadding(dp(8), 0, dp(4), 0)
            }
            null -> View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 0) }
        }
    }

    /** 一颗圆底的小按钮（背景画出来，不另加图片资源）。 */
    private fun ring(fill: Int, stroke: Int): android.graphics.drawable.GradientDrawable =
        android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.OVAL
            setColor(fill)
            setStroke(dp(1), stroke)
        }

    /** 点清单里一行：换成选中它，顺手查一下那台的界面旧没旧。 */
    private fun selectAddress(address: String) {
        selectedAddress = address
        renderSettings()
        checkBundledMedia(address)
    }

    /** 展开 / 收起填地址那一行（展开时把键盘叫出来，填完直接回车）。 */
    private fun showAddressRow(show: Boolean) {
        addressRow.visibility = if (show) View.VISIBLE else View.GONE
        renderSettings()
        if (!show) {
            hideKeyboard()
            return
        }
        addressInput.setText("")
        addressInput.requestFocus()
        addressInput.post {
            val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
            imm.showSoftInput(addressInput, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(addressInput.windowToken, 0)
    }

    /** 长按一行：问一声再把它从清单里删掉（删的是记下的地址，不掐已经连着的连接）。 */
    private fun confirmForget(address: String) {
        AlertDialog.Builder(this)
            .setMessage("从清单里删掉 ${hostOf(address)} ？")
            .setNegativeButton("取消", null)
            .setPositiveButton("删掉") { _, _ ->
                forget(address)
                bundleResults.remove(address)
                if (selectedAddress == address) { selectedAddress = null }
                renderSettings()
                selectedAddress?.let { checkBundledMedia(it) }
            }
            .show()
    }

    // ------------------------------------------------------------------------
    // 地址（清单里那些 + 填地址那一行）
    // ------------------------------------------------------------------------

    /**
     * 用一个地址打开对话：规范化、记进清单、叫服务重连、切到网页画面。
     * 清单里选中那台、和填地址那一行来的，都走这一条。地址不像话就写一句、返回 false。
     */
    private fun openAddress(raw: String): Boolean {
        val normalized = normalize(raw)
        if (normalized == null) {
            Toast.makeText(this, "地址不像话：填个「主机:端口」，或者带上 http:// 开头", Toast.LENGTH_LONG).show()
            return false
        }
        remember(normalized)
        selectedAddress = normalized
        addressRow.visibility = View.GONE
        hideKeyboard()
        renderSettings()
        startService(Intent(this, NoticeService::class.java).apply {
            action = NoticeService.ACTION_RECONNECT
        })
        openPage(null)
        return true
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

    /**
     * 切到网页画面。session 给了就带到那个会话上。
     *
     * 页面已经在（同一个地址，上一次打开过、没被清掉）就不再整页重来：点一下通知就整页重载
     * 很扎眼 —— 会话列表、连着的长连接、滚动位置全重新来过。这会儿只叫页面自己切到那个会话
     * （`window.pichatSwitchSession`，就是顶条上点一格那一下）。页面不在、或者是旧的界面文件
     * 没有那颗接口，才照旧带上 `?session=` 整个加载一遍。
     */
    private fun openPage(session: String?) {
        val base = savedAddress()
        if (base == null) {
            Toast.makeText(this, "先填后端地址", Toast.LENGTH_SHORT).show()
            return
        }
        settingsScroll.visibility = View.GONE
        webPanel.visibility = View.VISIBLE
        lastBackAt = 0L
        if (loadedBase == base && !session.isNullOrEmpty()) {
            val result = JSONObject.quote(session)
            web.evaluateJavascript(
                "(function(){if(typeof window.pichatSwitchSession!=='function'){return false;}" +
                    "window.pichatSwitchSession($result);return true;})()"
            ) { answer ->
                // 回来的不是 "true"：页面还停在错误页上、或者是旧版界面没有那颗接口 —— 退回整个加载一遍
                if (answer != "true") { loadPage(base, session) }
            }
            return
        }
        loadPage(base, session)
    }

    /** 整个加载一遍网页（页面还没装过、换了地址、或者页面那边没法就地切会话时）。 */
    private fun loadPage(base: String, session: String?) {
        var url = "$base/"
        if (!session.isNullOrEmpty()) {
            url += "?session=" + URLEncoder.encode(session, "UTF-8")
        }
        loadedBase = base
        web.loadUrl(url)
    }

    /** 回到设置画面（网页那层收起来，加载着的页面停掉）。 */
    private fun showSettings() {
        web.stopLoading()
        web.loadUrl("about:blank")
        loadedBase = null
        webPanel.visibility = View.GONE
        settingsScroll.visibility = View.VISIBLE
        // 回到这一屏：选中回到刚连的那台，再对一次它的界面旧没旧
        selectedAddress = savedAddress()
        renderSettings()
        selectedAddress?.let { checkBundledMedia(it) }
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
     * 查这一台（`base`）的界面文件旧没旧：拿包里带着的那份指纹（assets/media-manifest.json）
     * 跟它后端现在发的一比（`GET /media-manifest.json`，就是电脑上 media/ 里那几份 js / css
     * 此刻的指纹，跟页面地址里的 `?v=` 同一套算法）。结论记在 bundleResults 里、行右边跟着画。
     *
     * 只比界面文件：app 自己的改动（通知、返回键这些）不在这份清单里，那种只能看仓库里改没改。
     */
    private fun checkBundledMedia(base: String) {
        bundleResults[base] = BundleResult(BundleState.CHECKING)
        renderSettings()
        bundleCheckClient.newCall(Request.Builder().url("$base/media-manifest.json").build())
            .enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    onMain { applyBundleResult(base, null, "连不上") }
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
                        applyBundleResult(base, remote, if (remote == null) "后端没给这份清单（HTTP $code）" else "")
                    }
                }
            })
    }

    /**
     * 把一次检查的结果记下来、重摆那一行。remote 是后端那份清单（文件名 → 指纹），
     * 取不到给 null 并说明原因。两边对不上的文件名一个都不漏
     * （后端新加了、包里没有的也算旧的，那同样是该重打一个包）。
     */
    private fun applyBundleResult(base: String, remote: Map<String, String>?, reason: String) {
        if (remote == null) {
            bundleResults[base] = BundleResult(BundleState.UNKNOWN, reason)
            renderSettings()
            return
        }
        val bundled = bundledHashes()
        val stale = (remote.keys + bundled.keys).filter { remote[it] != bundled[it] }.sorted()
        bundleResults[base] = if (stale.isEmpty()) {
            BundleResult(BundleState.OK)
        } else {
            BundleResult(BundleState.STALE, stale.joinToString("、"))
        }
        renderSettings()
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
     * 清单右边那颗下载按钮：叫电脑现打一个包 → 隔一会儿问一次打好没 → 下下来 → 交给系统安装器。
     *
     * 为什么得在电脑上打：界面文件（`media/` 那几份）是打包那一刻从电脑上拷进 APK 的，
     * 手机手边没有它们。三条口都在后端那边：`POST /apk/build`（开始）、`GET /apk/build`
     * （进度）、`GET /apk`（把包发过来），见 src/apkBuild.ts。
     *
     * 整串在后台线程里跑（打包要几十秒到几分钟），界面上只换那行进展；
     * 正在跑的时候再点不会再起一份（gradle 两个进程同时写一个 build 目录会互相踩）。
     */
    private fun buildAndInstallApk(base: String) {
        if (apkBusy) { return }
        apkBusy = true
        // 那颗下载按钮先变成「…」：再点也没用，免得看成没反应
        renderSettings()
        showApkNote("正在叫电脑打包…")
        // 打包那一段只知道 “还在跑” 和跑了多少秒，给不出百分比：横条转圈
        showApkProgress(null, 0)
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

    /**
     * 把编好的包拉下来，一边拉一边写进系统安装会话（不落磁盘：省得留一份装完没用的文件）。
     *
     * 下载这条路断了不从头再来：记着已经下到第几个字节，隔一会儿带上 `Range: bytes=N-`
     * 再要一次，接着往同一个安装会话里写（服务端认这个，见 webChatServer 的 sendApk）。
     * 进度条按 HEAD 问到的总大小画。
     */
    private fun downloadAndInstallApk(base: String) {
        val size = apkSize(base) ?: return
        if (!canInstall()) { return }
        showApkNote("正在下载新版（${megabytes(size)}）…")
        showApkProgress(0, size)
        // 一次安装会话从头用到尾：断的那几次也接着往这一个里写（不另开一份）
        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            session.openWrite("pi-chat.apk", 0, size).use { sink ->
                var done = 0L
                var attempt = 0
                while (done < size) {
                    attempt += 1
                    if (attempt > 1) {
                        // 每断一回多停一会儿（第一次 1.5 秒，之后一次次加长）
                        val wait = APK_RETRY_WAIT_MS * (attempt - 1)
                        showApkNote("断了（下了 ${megabytes(done)} / ${megabytes(size)}），" +
                            "${(wait + 999) / 1000} 秒后接着下…")
                        Thread.sleep(wait)
                        showApkNote("接着下（已下 ${megabytes(done)} / ${megabytes(size)}）…")
                    }
                    try {
                        // 每写一块就把“下到哪儿了”记下来：断在半路也接得上
                        downloadPiece(base, done, size, sink) { now ->
                            done = now
                            showApkProgress(now, size)
                        }
                    } catch (error: Exception) {
                        if (attempt >= APK_DOWNLOAD_TRIES) {
                            throw IOException("下了 ${megabytes(done)} 断了 ${attempt} 次，点一下再试（电脑上那个包还在）")
                        }
                        // 下一次循环带着 Range 接着要（这里不重报错，上面那行字已经写着断了）
                    }
                }
                session.fsync(sink)
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

    /**
     * 下一段：从第 `from` 个字节开始要（0 就是整份），写进安装会话；
     * 每写一块就通过 `land` 报一次“现在一共下到多少”（断了也还在，外面接着要下一段）。
     * 连接断了这里抛出去。
     */
    private fun downloadPiece(base: String, from: Long, size: Long, sink: OutputStream, land: (Long) -> Unit) {
        val request = Request.Builder().url("$base/apk").apply {
            if (from > 0) { header("Range", "bytes=$from-") }
        }.build()
        apkClient.newCall(request).execute().use { response ->
            // 续传时服务端必须真按 Range 回（206）：回 200 就是把整份从头发，
            // 那一段字节再接在已经写过的后面就是一个环包，宁可当这次没成
            if (from > 0 && response.code != 206) {
                throw IOException("电脑那边没按从中间接着发（HTTP ${response.code}）")
            }
            if (from == 0L && !response.isSuccessful) {
                throw IOException("HTTP ${response.code}" + if (response.code == 404) "（电脑上还没打好）" else "")
            }
            val body = response.body ?: throw IOException("没有正文")
            val buffer = ByteArray(64 * 1024)
            var done = from
            body.byteStream().use { input ->
                while (done < size) {
                    val read = input.read(buffer)
                    if (read < 0) { break }   // 没收到头就断了：交给外面再要一段
                    sink.write(buffer, 0, read)
                    done += read
                    land(done)
                }
            }
        }
    }

    /**
     * 问一句包有多大（HEAD，只回个头）：进度条按它画。拿不到就写一行字、给 null。
     *
     * 大小得从 `Content-Length` 那个头里读，不能用 `body.contentLength()`：
     * OkHttp 对 HEAD 的正文一律当成 0 字节（量过：头里 2109749，body.contentLength() 是 0），
     * 照着它判断就是“永远没写多大”。
     */
    private fun apkSize(base: String): Long? {
        apkClient.newCall(Request.Builder().url("$base/apk").head().build()).execute().use { response ->
            if (!response.isSuccessful) {
                showApkNote("拿不到包：HTTP ${response.code}" +
                    if (response.code == 404) "（电脑上还没打好）" else "")
                return null
            }
            val size = response.header("Content-Length")?.trim()?.toLongOrNull() ?: -1L
            if (size <= 0) {
                showApkNote("拿到的包没写多大（Content-Length 没有），装不了")
                return null
            }
            return size
        }
    }

    /** 能不能装：没允许「安装未知应用」就先带人去掉那一步，回去再点一遍（返回 false）。 */
    private fun canInstall(): Boolean {
        if (packageManager.canRequestPackageInstalls()) { return true }
        onMain {
            showApkNote("得先在系统里允许这个 app「安装未知应用」，回来再点一次")
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName")))
            } catch (_: Exception) {
                Toast.makeText(this, "到系统设置里找「安装未知应用」", Toast.LENGTH_LONG).show()
            }
        }
        return false
    }

    /** 一个数字带单位（进度条旁边那行字用）：1.4 MB。 */
    private fun megabytes(bytes: Long): String =
        String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)

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

    /** 换那行进展（后台线程叫的，自己负责回主线程）。给空串就把那行收起来。 */
    private fun showApkNote(text: String) {
        onMain {
            apkBuildText.text = text
            apkBuildText.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
        }
    }

    /**
     * 那根横条：`done` 给 null = 不知道进度（打包那段，转圈）；
     * 给了数就按 done / total 画（下载那段，每写一块就动一格）。
     * 后台线程叫的，自己负责回主线程。
     */
    private fun showApkProgress(done: Long?, total: Long) {
        onMain {
            apkProgress.visibility = View.VISIBLE
            if (done == null || total <= 0) {
                apkProgress.isIndeterminate = true
                return@onMain
            }
            apkProgress.isIndeterminate = false
            apkProgress.progress = ((done * 1000) / total).toInt().coerceIn(0, 1000)
        }
    }

    /**
     * 打包 / 下载跑完了：把横条收起来，清单重摆一遍
     * （那颗下载按钮带着「…」跑完要变回去 / 变回一颗勾）。
     */
    private fun syncApkControls() {
        if (!apkBusy) { apkProgress.visibility = View.GONE }
        renderSettings()
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
