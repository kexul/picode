package dev.pichat.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机以后把收提醒那颗服务接着挂上：不然重启一次就收不到，还得自己来开一下。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) { return; }
        if (Settings.baseUrl(context).isEmpty()) { return; }
        try {
            PhoneService.start(context);
        } catch (Exception ignored) {
            // 系统不让起（国产系统上常见）：开 app 的时候还会起来
        }
    }
}
