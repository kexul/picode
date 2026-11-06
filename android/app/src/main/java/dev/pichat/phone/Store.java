package dev.pichat.phone;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 后端推来的东西都放这儿：开着哪些会话、每个会话留着的那几条、哪几道题已经答过了。
 *
 * 收提醒的服务在后台线程往这儿写，列表和会话页从这儿读；东西一变就叫一遍听着的界面
 * （都在主线程叫，界面直接改控件就行）。
 *
 * 只放在内存里：服务一直挂着，界面关了再开还是这一份；整个进程被系统收掉了就重新连一次，
 * 后端连上时会先给一份现状（见 PhoneService 里的 snapshot）。
 */
final class Store {
    private static final String TAG = "pichat-phone";

    /** 一条「有事」：跑完一轮说的话、模型问的一道题，或者自己刚说的一句话。 */
    static final class Note {
        final int seq;
        final String sessionId;
        final String name;
        final String kind;
        final String text;
        final String from;
        final long at;
        /** 只有 kind 是 ask 才有：cardId、选项那些，原样留着。 */
        final JSONObject ask;
        /** 这句话「怎么画」：后端解析好的一份结构（见 src/markdownBlocks.ts）；自己刚发的那句没有。 */
        final JSONArray blocks;
        /** 压成一句话的预览（会话列表上那一行）。 */
        final String plain;
        /** 这道题已经在别处答过了：界面上那几个选项直接置灰。 */
        final boolean settled;

        Note(JSONObject json) {
            seq = json.optInt("seq", 0);
            sessionId = json.optString("sessionId", "");
            name = json.optString("name", "");
            kind = json.optString("kind", "done");
            text = json.optString("text", "");
            from = json.optString("from", "");
            at = json.optLong("at", System.currentTimeMillis());
            ask = json.optJSONObject("ask");
            blocks = json.optJSONArray("blocks");
            plain = json.optString("plain", "");
        // 这道题已经在别处答过了（重新连上时后端给的那份里带着）：那几个选项直接置灰
        settled = json.optBoolean("settled", false);
        }

        private Note(int seq, String sessionId, String name, String kind, String text, long at) {
            this.seq = seq;
            this.sessionId = sessionId;
            this.name = name;
            this.kind = kind;
            this.text = text;
            this.from = "";
            this.at = at;
            this.ask = null;
            this.blocks = null;
            this.plain = "";
            this.settled = false;
        }

        /** 自己刚发出去的那一句：先上屏，后端再推回来时就不重复了（见 addLocked）。 */
        static Note local(String sessionId, String name, String text) {
            return new Note(0, sessionId, name, "me", text, System.currentTimeMillis());
        }

        String cardId() {
            return ask == null ? "" : ask.optString("cardId", "");
        }
    }

    /** 列表上的一个会话（这一份是死的：变了就换一个新的）。 */
    static final class Session {
        final String id;
        final String name;
        final boolean running;
        final boolean remote;
        final Note last;

        Session(JSONObject json) {
            id = json.optString("id", "");
            String raw = json.optString("name", "");
            name = raw.isEmpty() ? "会话" : raw;
            running = json.optBoolean("running", false);
            remote = json.optBoolean("remote", false);
            JSONObject lastJson = json.optJSONObject("last");
            last = lastJson == null ? null : new Note(lastJson);
        }

        private Session(String id, String name, boolean running, boolean remote, Note last) {
            this.id = id;
            this.name = name;
            this.running = running;
            this.remote = remote;
            this.last = last;
        }

        Session withLast(Note note) {
            return new Session(id, name, running, remote, note);
        }
    }

    private static final Map<String, Session> sessions = new LinkedHashMap<>();
    private static final Map<String, List<Note>> notes = new HashMap<>();
    private static final Set<String> answered = new HashSet<>();
    private static final List<Runnable> listeners = new ArrayList<>();
    private static final Handler ui = new Handler(Looper.getMainLooper());

    /** 会话页正看着的那个会话（在它上面时就不弹通知了）。 */
    private static volatile String viewing = "";

    private Store() { }

    // ------------------------------------------------------------------
    //  给界面读的
    // ------------------------------------------------------------------

    /** 列表要摆的那些会话：有事的排前面（按最后一条的时间倒着排），没通知的排后面。 */
    static synchronized List<Session> sessions() {
        List<Session> list = new ArrayList<>(sessions.values());
        list.sort((a, b) -> {
            long ta = a.last == null ? Long.MIN_VALUE : a.last.at;
            long tb = b.last == null ? Long.MIN_VALUE : b.last.at;
            return Long.compare(tb, ta);
        });
        return list;
    }

    static synchronized Session session(String id) {
        return id == null ? null : sessions.get(id);
    }

    static synchronized List<Note> notes(String id) {
        List<Note> list = id == null ? null : notes.get(id);
        return list == null ? new ArrayList<>() : new ArrayList<>(list);
    }

    static synchronized boolean isAnswered(String cardId) {
        return cardId != null && !cardId.isEmpty() && answered.contains(cardId);
    }
    /** 这个会话里最近一道题还没答（列表上那一行要显眼，哪怕最后一条已经是别的）。 */
    static synchronized boolean waitingAnswer(String sessionId) {
        List<Note> list = sessionId == null ? null : notes.get(sessionId);
        if (list == null) { return false; }
        for (int i = list.size() - 1; i >= 0; i--) {
            Note note = list.get(i);
            if (note.ask != null) { return !answered.contains(note.cardId()); }
        }
        return false;
    }

    /** 界面进来听、走的时候别忘取消（不然页面都关了还在往里塞东西）。 */
    static void listen(Runnable listener) {
        synchronized (Store.class) {
            if (!listeners.contains(listener)) { listeners.add(listener); }
        }
    }

    static void unlisten(Runnable listener) {
        synchronized (Store.class) {
            listeners.remove(listener);
        }
    }

    // ------------------------------------------------------------------
    //  给服务写的
    // ------------------------------------------------------------------

    /** 服务那边收到一段事件，原样交过来（snapshot / sessions / note）。 */
    static void onEvent(String event, String data) {
        try {
            if ("snapshot".equals(event)) {
                replace(new JSONObject(data).optJSONArray("sessions"), true);
            } else if ("sessions".equals(event)) {
                replace(new JSONObject(data).optJSONArray("sessions"), false);
            } else if ("note".equals(event)) {
                synchronized (Store.class) {
                    addLocked(new Note(new JSONObject(data)));
                }
                wake();
            }
        } catch (Exception e) {
            Log.w(TAG, "这段读不懂：" + event + " " + data);
        }
    }

    /** 长连接还没连上时兜底拉的那份列表（GET /phone/sessions）。 */
    static void applySessions(JSONArray array) {
        replace(array, false);
    }

    /** 会话页进来时对齐的那一份（GET /phone/session）：会话这一行和它留着的几条都换成这一份。 */
    static void applyDetail(String sessionId, JSONObject session, JSONArray array) {
        synchronized (Store.class) {
            if (session != null) {
                Session parsed = new Session(session);
                if (!parsed.id.isEmpty()) { sessions.put(parsed.id, parsed); }
            }
            List<Note> list = new ArrayList<>();
            if (array != null) {
                for (int i = 0; i < array.length(); i++) {
                    JSONObject item = array.optJSONObject(i);
                    if (item != null) {
                        Note parsed = new Note(item);
                        list.add(parsed);
                        if (parsed.settled && !parsed.cardId().isEmpty()) { answered.add(parsed.cardId()); }
                    }
                }
            }
            notes.put(sessionId, list);
        }
        wake();
    }

    /** 自己刚发出去的一句话：先上屏，不等后端推回来。 */
    static void addLocalMe(String sessionId, String name, String text) {
        synchronized (Store.class) {
            addLocked(Note.local(sessionId, name, text));
        }
        wake();
    }

    /** 这道题答过了：列表上那行「在等你答一句」、会话页那几个按钮都跟着收起来。 */
    static void markAnswered(String cardId) {
        if (cardId == null || cardId.isEmpty()) { return; }
        synchronized (Store.class) {
            answered.add(cardId);
        }
        wake();
    }

    /** 换了后端地址：原来那份不能留着（不然列表上全是另一台机器的会话）。 */
    static void clear() {
        synchronized (Store.class) {
            sessions.clear();
            notes.clear();
            answered.clear();
        }
        wake();
    }

    /** 会话页在前台看着的就是这个会话时，通知就不弹（省得自己弹自己）。 */
    static void setViewing(String sessionId) {
        viewing = sessionId == null ? "" : sessionId;
    }

    static boolean isViewing(String sessionId) {
        return sessionId != null && !sessionId.isEmpty() && sessionId.equals(viewing);
    }

    // ------------------------------------------------------------------
    //  里面怎么改
    // ------------------------------------------------------------------

    private static synchronized void replace(JSONArray array, boolean withNotes) {
        if (array == null) { return; }
        Map<String, Session> nextSessions = new LinkedHashMap<>();
        Map<String, List<Note>> nextNotes = new HashMap<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) { continue; }
            Session session = new Session(item);
            if (session.id.isEmpty()) { continue; }
            nextSessions.put(session.id, session);
            if (withNotes) {
                List<Note> list = new ArrayList<>();
                JSONArray arr = item.optJSONArray("notes");
                if (arr != null) {
                    for (int j = 0; j < arr.length(); j++) {
                        JSONObject one = arr.optJSONObject(j);
                        if (one != null) {
                            Note parsed = new Note(one);
                            list.add(parsed);
                            if (parsed.settled && !parsed.cardId().isEmpty()) { answered.add(parsed.cardId()); }
                        }
                    }
                }
                nextNotes.put(session.id, list);
            } else {
                List<Note> old = notes.get(session.id);
                if (old != null) { nextNotes.put(session.id, old); }
            }
        }
        sessions.clear();
        sessions.putAll(nextSessions);
        notes.clear();
        notes.putAll(nextNotes);
        wake();
    }

    private static void addLocked(Note note) {
        if (note.sessionId.isEmpty()) { return; }
        List<Note> list = notes.get(note.sessionId);
        if (list == null) {
            list = new ArrayList<>();
            notes.put(note.sessionId, list);
        }
        // 同一条别来两遍（断线重连时 snapshot 里可能已经有了）
        if (note.seq > 0) {
            for (int i = list.size() - 1; i >= 0; i--) {
                if (list.get(i).seq == note.seq) { return; }
            }
        }
        // 自己刚发的那句：本地先上屏的和后端推回来的只留一条（哪条先到都可能）
        if ("me".equals(note.kind)) {
            for (int i = list.size() - 1; i >= 0 && i >= list.size() - 5; i--) {
                Note old = list.get(i);
                if (!"me".equals(old.kind) || !old.text.equals(note.text)
                    || note.at - old.at >= 60000) {
                    continue;
                }
                if (old.seq == 0 && note.seq > 0) {
                    // 后端把这条推回来了：换成它那份（编号、时刻都对上了），别重复
                    list.set(i, note);
                    Session session = sessions.get(note.sessionId);
                    if (session != null && session.last == old) {
                        sessions.put(note.sessionId, session.withLast(note));
                    }
                    return;
                }
                if (note.seq == 0) {
                    // 后端那条已经先到了：本地这条不用再上屏
                    return;
                }
            }
        }
        list.add(note);
        if (list.size() > 60) { list.subList(0, list.size() - 60).clear(); }
        Session session = sessions.get(note.sessionId);
        if (session == null) {
            session = new Session(note.sessionId, note.name.isEmpty() ? "会话" : note.name,
                false, note.sessionId.startsWith("remote:"), note);
        } else {
            session = session.withLast(note);
        }
        sessions.put(note.sessionId, session);
    }

    private static void wake() {
        final List<Runnable> copy;
        synchronized (Store.class) {
            if (listeners.isEmpty()) { return; }
            copy = new ArrayList<>(listeners);
        }
        ui.post(() -> {
            for (Runnable listener : copy) {
                try {
                    listener.run();
                } catch (RuntimeException e) {
                    Log.w(TAG, "更新界面出错：" + e);
                }
            }
        });
    }

    // ------------------------------------------------------------------
    //  跟后端打交道的那两下（GET / POST 一小段 JSON）
    // ------------------------------------------------------------------

    static JSONObject get(String url) throws Exception {
        return request("GET", url, null);
    }

    static JSONObject post(String url, JSONObject body) throws Exception {
        return request("POST", url, body.toString());
    }

    private static JSONObject request(String method, String url, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Accept", "application/json");
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : readAll(in);
            if (text.isEmpty()) { throw new Exception("后端回了 HTTP " + code + "，没有内容"); }
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) > 0) { out.write(buffer, 0, n); }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 出错了的原因写成一句能给人看的话。 */
    static String reason(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }

    /** 后端回的 ok:false 带着的原因。 */
    static String reason(JSONObject res) {
        String reason = res.optString("reason", "");
        return reason.isEmpty() ? "后端没说是为什么" : reason;
    }

    // ------------------------------------------------------------------
    //  时间怎么写
    // ------------------------------------------------------------------

    /** 今天的写时刻，早的写日期（列表上一行用）。 */
    static String shortTime(long at) {
        if (at <= 0) { return ""; }
        Date date = new Date(at);
        return new SimpleDateFormat(sameDay(date) ? "HH:mm" : "MM-dd", Locale.US).format(date);
    }

    /** 今天的写时刻，早的写日期和时刻（会话页那一条上用）。 */
    static String fullTime(long at) {
        if (at <= 0) { return ""; }
        Date date = new Date(at);
        return new SimpleDateFormat(sameDay(date) ? "HH:mm" : "MM-dd HH:mm", Locale.US).format(date);
    }

    private static boolean sameDay(Date date) {
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(date);
        return today.equals(day);
    }
}
