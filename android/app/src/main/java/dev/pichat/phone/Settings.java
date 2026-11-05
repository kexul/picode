package dev.pichat.phone;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

/** 手机上存的那一点东西：后端地址、收不收提醒、这台手机的标识。 */
final class Settings {
    private static final String FILE = "pichat-phone";
    private static final String KEY_URL = "baseUrl";
    private static final String KEY_ON = "on";
    private static final String KEY_CLIENT = "clientId";

    private Settings() { }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** 后端地址（规范化过：带 http://、末尾不带斜杠）；没填就是空串。 */
    static String baseUrl(Context ctx) {
        return normalize(prefs(ctx).getString(KEY_URL, ""));
    }

    static void setBaseUrl(Context ctx, String url) {
        prefs(ctx).edit().putString(KEY_URL, normalize(url)).apply();
    }

    /** 要不要收提醒（界面上那颗开关）。关着的时候开机也不去连。 */
    static boolean on(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ON, false);
    }

    static void setOn(Context ctx, boolean on) {
        prefs(ctx).edit().putBoolean(KEY_ON, on).apply();
    }

    /** 这台手机的标识：后端拿它认“同一个连接又来了”，生成了就一直用。 */
    static String clientId(Context ctx) {
        String id = prefs(ctx).getString(KEY_CLIENT, "");
        if (id != null && !id.isEmpty()) { return id; }
        id = "phone-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        prefs(ctx).edit().putString(KEY_CLIENT, id).apply();
        return id;
    }

    /** 人可能只填了 `100.64.0.2:51883`：补上 http://、去掉末尾的斜杠。 */
    static String normalize(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) { return ""; }
        if (!url.contains("://")) { url = "http://" + url; }
        while (url.endsWith("/")) { url = url.substring(0, url.length() - 1); }
        return url;
    }
}
