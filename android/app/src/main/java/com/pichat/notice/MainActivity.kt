package com.pichat.notice

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.net.URLEncoder

/**
 * MainActivity —— app 的唯一一屏，两种画面：
 *
 * - 设置画面：填后端地址（网页里那个，比如 `192.168.1.40:1867`）、保存并重连、
 *   顺手也能把对话页面打开看看；
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
        const val KEY_SERVER = "server"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var settingsPanel: LinearLayout
    private lateinit var addressInput: EditText
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
            setPadding(dp(20), dp(28), dp(20), 0)
        }
        settingsPanel.addView(TextView(this).apply {
            text = "Pi 提醒"
            textSize = 24f
            setPadding(0, 0, 0, dp(12))
        })
        settingsPanel.addView(TextView(this).apply {
            text = "填电脑上后端的地址（浏览器里打开的那个，比如 192.168.1.40:1867）。手机要跟电脑连同一个网络。"
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
            text = "保存并重连"
            setOnClickListener { saveAddress() }
        })
        settingsPanel.addView(Button(this).apply {
            text = "打开对话页面"
            setOnClickListener { openPage(null) }
        })
        settingsPanel.addView(TextView(this).apply {
            text = "连接状态看通知栏那条常驻提示；收到的提醒要是没弹出来，\n" +
                "到系统的设置里把这个 app 的电池优化关掉（各品牌叫法不一，多在「省电」或「应用管理」里）。"
            textSize = 12f
            setTextColor(Color.GRAY)
            setPadding(0, dp(16), 0, 0)
        })
        root.addView(settingsPanel)

        // —— 网页画面（默认收起来）——
        webPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        webPanel.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.rgb(30, 111, 92))
            setPadding(dp(8), dp(6), dp(8), dp(6))
            addView(Button(this@MainActivity).apply {
                text = "← 设置"
                setBackgroundColor(Color.TRANSPARENT)
                setTextColor(Color.WHITE)
                setOnClickListener { showSettings() }
            })
        })
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
            layoutParams = LinearLayout.LayoutParams(0, 0)   // 占满余下空间，见下面的 weight
        }
        webPanel.addView(web, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(webPanel, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
    }

    /** 填的地址存下来（规范化成 `http://主机:端口` 的样子），并叫服务重连。 */
    private fun saveAddress() {
        val normalized = normalize(addressInput.text.toString())
        if (normalized == null) {
            Toast.makeText(this, "地址不像话：填个「主机:端口」，或者带上 http:// 开头", Toast.LENGTH_LONG).show()
            return
        }
        prefs.edit().putString(KEY_SERVER, normalized).apply()
        Toast.makeText(this, "已保存：$normalized", Toast.LENGTH_SHORT).show()
        startService(Intent(this, NoticeService::class.java).apply {
            action = NoticeService.ACTION_RECONNECT
        })
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
        settingsPanel.visibility = View.GONE
        webPanel.visibility = View.VISIBLE
        web.loadUrl(url)
    }

    /** 回到设置画面（网页那层收起来，加载着的页面停掉）。 */
    private fun showSettings() {
        web.stopLoading()
        web.loadUrl("about:blank")
        webPanel.visibility = View.GONE
        settingsPanel.visibility = View.VISIBLE
    }

    /** 返回键：网页画面时先回设置，不退出 app。 */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webPanel.visibility == View.VISIBLE) {
            showSettings()
        } else {
            super.onBackPressed()
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
