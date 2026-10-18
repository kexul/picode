package dev.pichat.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.List;

/**
 * 这台手机上记着的东西：后端地址清单（按用过的先后排），以及那条后台连接的身份（pageId）。
 *
 * 地址清单存成一个用换行拼起来的字符串 —— 就几个地址，不值得为它引入一套存储。
 */
final class Prefs {
    private static final String FILE = "pichat";
    private static final String KEY_LIST = "addresses";
    private static final String KEY_BASE = "base";
    private static final String KEY_PAGE = "pageId";
    /** 清单最多留几个：多了没必要，只是历史。 */
    private static final int MAX_ADDRS = 10;

    private Prefs() {}

    private static SharedPreferences store(Context ctx) {
        return ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** 用过的地址，最近用的在第一个。 */
    static List<String> addresses(Context ctx) {
        String raw = store(ctx).getString(KEY_LIST, "");
        List<String> out = new ArrayList<>();
        for (String item : raw.split("\n")) {
            if (!item.isEmpty()) { out.add(item); }
        }
        return out;
    }

    /** 把地址记到清单第一个（已经在的挪上来），顺手设成"上次用的那个"。 */
    static void remember(Context ctx, String base) {
        if (base == null || base.isEmpty()) { return; }
        List<String> list = new ArrayList<>();
        list.add(base);
        for (String item : addresses(ctx)) {
            if (!item.equals(base) && list.size() < MAX_ADDRS) { list.add(item); }
        }
        store(ctx).edit()
            .putString(KEY_LIST, String.join("\n", list))
            .putString(KEY_BASE, base)
            .apply();
    }

    /** 上次连上的那个地址（还没连过就是空串）。 */
    static String base(Context ctx) {
        return store(ctx).getString(KEY_BASE, "");
    }

    /**
     * 这条后台连接报给后端的身份。固定不变：重连、App 重启都还是同一块"屏"，
     * 后端那边看到的就是"这条又连上了"，不是又冒出来一个新页面。
     */
    static String pageId(Context ctx) {
        String id = store(ctx).getString(KEY_PAGE, "");
        if (id.isEmpty()) {
            id = "app-" + Long.toHexString(System.currentTimeMillis()) + "-" + Long.toHexString((long) (Math.random() * 0xFFFFFF));
            store(ctx).edit().putString(KEY_PAGE, id).apply();
        }
        return id;
    }

    /**
     * 人填的地址收拾成能用的样子：去掉两头空白，没写协议就当 http，
     * 去掉末尾的斜杠和各种尾巴，最后补一个斜杠（后面要往它身上拼 /events、/api）。
     *
     * @return 收拾不了（空、有空格、不像个地址）返回空串
     */
    static String normalize(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) { return ""; }
        if (!text.contains("://")) { text = "http://" + text; }
        int schemeAt = text.indexOf("://");
        String scheme = text.substring(0, schemeAt).toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https")) { return ""; }
        String rest = text.substring(schemeAt + 3);
        while (rest.endsWith("/")) { rest = rest.substring(0, rest.length() - 1); }
        if (rest.isEmpty() || rest.contains(" ")) { return ""; }
        return scheme + "://" + rest + "/";
    }
}
