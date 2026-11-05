package dev.pichat.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/**
 * 通知这件事：两颗通道（一条常驻、一条有事弹）、一条点开就回 app 的入口。
 *
 * 常驻那条是前台服务挂着的：没有它，系统迟早会把后台那条连接掐掉，通知就收不到了。
 */
final class Notifier {
    /** 前台服务挂着的那条常驻通知的编号。 */
    static final int SERVICE_ID = 1;
    /** 有事弹的那条从这儿往后排（一个会话一条，后来的顶掉前一个）。 */
    private static final int NOTE_ID_BASE = 100;

    private static final String CHANNEL_SERVICE = "service";
    private static final String CHANNEL_NOTES = "notes";

    private Notifier() { }

    static void ensureChannels(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) { return; }
        NotificationChannel service = new NotificationChannel(CHANNEL_SERVICE, "收提醒的常驻通知", NotificationManager.IMPORTANCE_LOW);
        service.setDescription("收提醒的时候一直显示着（不然系统会把后台那条连接掐掉）");
        service.setShowBadge(false);
        nm.createNotificationChannel(service);
        NotificationChannel notes = new NotificationChannel(CHANNEL_NOTES, "会话提醒", NotificationManager.IMPORTANCE_HIGH);
        notes.setDescription("会话跑完一轮、或者模型在等你答一句");
        notes.enableVibration(true);
        nm.createNotificationChannel(notes);
    }

    /** 前台服务挂着的那条：正文写着现在连到哪儿了。 */
    static Notification service(Context ctx, String status) {
        return new Notification.Builder(ctx, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_note)
            .setContentTitle("Pi Chat")
            .setContentText(status)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openApp(ctx, null))
            .build();
    }

    /** 有事了：弹一条。同一个会话后来的顶掉前一条（别在通知栏里堆一排）。 */
    static void postNote(Context ctx, String name, String summary, String kind, String sessionId, String from, long at) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) { return; }
        String title = (from == null || from.isEmpty()) ? name : from + " · " + name;
        String text = (summary == null || summary.isEmpty()) ? "（没有文字，点开看看）" : summary;
        Notification.Builder builder = new Notification.Builder(ctx, CHANNEL_NOTES)
            .setSmallIcon(R.drawable.ic_note)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(at > 0 ? at : System.currentTimeMillis())
            .setContentIntent(openApp(ctx, sessionId));
        if ("ask".equals(kind)) {
            builder.setSubText("在等你回一句");
        }
        int id = NOTE_ID_BASE + (sessionId == null ? 0 : Math.abs(sessionId.hashCode()) % 100000);
        nm.notify(id, builder.build());
    }

    /** 点通知进来的那条路：打开 app，并让它把页面切到那个会话。 */
    private static PendingIntent openApp(Context ctx, String sessionId) {
        Intent intent = new Intent(ctx, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null && !sessionId.isEmpty()) {
            intent.putExtra(MainActivity.EXTRA_SESSION, sessionId);
        }
        int requestCode = sessionId == null ? 0 : sessionId.hashCode();
        return PendingIntent.getActivity(ctx, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
