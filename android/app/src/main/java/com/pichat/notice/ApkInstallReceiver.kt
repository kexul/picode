package com.pichat.notice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.widget.Toast

/**
 * ApkInstallReceiver —— 装新包这件事的回话（见 MainActivity 的 installApk）。
 *
 * 手机上点「打包并安装新版」以后，新包是流进系统安装会话（PackageInstaller）里装的，
 * 系统答话就落到这儿：
 *
 * - `STATUS_PENDING_USER_ACTION`：系统要人点一下那句「更新应用」/「安装」。它把那张确认的
 *   Intent 放在 EXTRA_INTENT 里，得我们替它开起来 —— 不开的话手机上什么都不出现、装不下去，
 *   而且一点提示都没有（最容易当成“按钮没反应”的那种坏法）。
 * - `STATUS_SUCCESS`：装好了。装完这个 app 自己会被系统换掉（进程重启），所以这儿多半
 *   只来得及闪一句提示。
 * - 其余：没装上，把系统给的那句原因照说一遍。
 */
class ApkInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(confirm)
                } catch (_: Exception) {
                    Toast.makeText(context, "打不开安装确认框", Toast.LENGTH_LONG).show()
                }
            }
            return
        }
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        val text = if (status == PackageInstaller.STATUS_SUCCESS) {
            "装好了"
        } else {
            "没装上：$message"
        }
        Toast.makeText(context, text, Toast.LENGTH_LONG).show()
    }
}
