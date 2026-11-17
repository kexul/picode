import Foundation
import UIKit
import UserNotifications

/**
 AppModel —— 整个 app 的状态：现在连哪台后端、用过的地址清单、跟后端的提醒流。

 跟安卓那份（android/app/src/main/java/com/pichat/notice）一个意思、一套协议：
 地址存的是「协议://主机:端口」（同上：没写 http:// 就按 http），打开过的最多留 8 条；
 连着后端的 `GET /phone-notice`（SSE）：`type: notice` 弹一条本地通知、`type: close` 把那条撤掉。

 不一样的地方是 iOS 没有常驻前台服务：app 一退到后台，系统过几秒就把进程冻住，
 这条流也跟着停（见 ios/README.md「用的时候要知道的」）。所以这里只管「活着的时候连着」，
 断开按退避重连（2 秒起、翻倍、封顶 1 分钟），回到前台立刻再接一次。
 */
@MainActor
final class AppModel: ObservableObject {

    static let shared = AppModel()

    /// 跟安卓那边同一套键名（那边是 SharedPreferences，这边是 UserDefaults）。
    private enum Prefs {
        static let server = "server"
        static let history = "history"
    }

    /// 用过的地址最多留几条（满了挤掉最老的）。
    private static let historyLimit = 8
    /// 通知正文最多留多少字（跟安卓那边一样：通知栏显示不下）。
    private static let bodyChars = 280
    /// 会话提醒那条通知的编号前缀（后面接会话号：同一个会话换掉旧的）。
    private static let noticePrefix = "notice:"

    /// 现在用的后端地址（`http://主机:端口`，没填过是 nil）。
    @Published private(set) var server: String?
    /// 用过的地址（最新的在前）。
    @Published private(set) var history: [String] = []
    /// 地址输入框里那格的字。
    @Published var addressText = ""
    /// 跟后端这条流的状况（设置画面里那一行字）。
    @Published private(set) var status = "还没填后端地址"
    /// 是不是在看对话（false = 停在设置画面）。
    @Published private(set) var showChat = false
    /// 点通知进来时要看的那个会话（没带就是 nil = 照旧打开当前那个会话）。
    @Published private(set) var sessionId: String?
    /// 地址不像话时弹的那一句（界面看过就清掉）。
    @Published var complaint: String?

    private let defaults = UserDefaults.standard
    /// 连接循环（一个 Task 就是一条命；重连就是换一条）。
    private var loop: Task<Void, Never>?
    /// 这一轮连接里有没有真连上过（退避要不要从头算）。
    private var connected = false
    /// 退到后台时向系统要的那段宽限时间（能多活几秒）。
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// 眼下是不是在后台（回到前台时靠它决定要不要立刻重接一条）。
    private var inBackground = false

    /** 提醒流用的会话：比默认宽松（25 秒一次心跳，120 秒还没一个字节就当断了）。 */
    private let http: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private init() {
        let saved = defaults.string(forKey: Prefs.server)?.trimmingCharacters(in: .whitespaces)
        server = (saved?.isEmpty ?? true) ? nil : saved
        history = (defaults.stringArray(forKey: Prefs.history) ?? []).filter { !$0.isEmpty }
        addressText = server ?? ""
        status = server.map { "还没连（\($0)）" } ?? "还没填后端地址"
        start()
    }

    // ------------------------------------------------------------------------
    // 地址（输入框那一格 + 用过的地址清单），跟安卓 MainActivity 同一套规矩
    // ------------------------------------------------------------------------

    /**
     用一个地址打开对话：规范化、记进清单、叫连接循环重连、切到网页画面。
     输入框里的、历史清单里点来的，都走这一条。
     */
    func openAddress(_ raw: String) {
        guard let normalized = Self.normalize(raw) else {
            complaint = "地址不像话：填个「主机:端口」，或者带上 http:// 开头"
            return
        }
        addressText = normalized
        remember(normalized)
        // 改完地址不用重启 app：掐断当前连接，循环那头顶上会重新读地址、重新连
        start()
        sessionId = nil
        showChat = true
    }

    /**
     规范化地址：只留「协议://主机:端口」。带不带 http:// 都认（没写就当 http），
     末尾的斜杠去掉。不成样子给 nil。
     */
    static func normalize(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        var scheme = "http"
        let lower = text.lowercased()
        if lower.hasPrefix("http://") {
            text = String(text.dropFirst(7))
        } else if lower.hasPrefix("https://") {
            scheme = "https"
            text = String(text.dropFirst(8))
        }
        while text.hasSuffix("/") { text.removeLast() }
        text = text.trimmingCharacters(in: .whitespaces)
        if text.isEmpty || text.contains("/") || text.contains("?") || text.contains("#") { return nil }
        return "\(scheme)://\(text)"
    }

    /** 从清单里删掉一条（现在连着的那个地址不跟着动：删记录不掐连接）。 */
    func forget(_ address: String) {
        history = history.filter { $0 != address }
        defaults.set(history, forKey: Prefs.history)
    }

    /** 记下一个打开过的地址：去重、排到最前、挤掉太老的；它同时就是现在用的地址。 */
    private func remember(_ address: String) {
        server = address
        history = Array(([address] + history.filter { $0 != address }).prefix(Self.historyLimit))
        defaults.set(address, forKey: Prefs.server)
        defaults.set(history, forKey: Prefs.history)
    }

    // ------------------------------------------------------------------------
    // 两种画面之间切
    // ------------------------------------------------------------------------

    /** 回到设置画面（网页那边跟着拆掉，跟安卓回设置时清成 about:blank 一个意思）。 */
    func showSettings() {
        showChat = false
        sessionId = nil
    }

    /** 点通知进来：切到网页画面、带到那个会话上。 */
    func openSession(_ id: String) {
        sessionId = id
        showChat = true
    }

    // ------------------------------------------------------------------------
    // 生命周期（iOS 这边能做的就这么点）
    // ------------------------------------------------------------------------

    /** 回到前台：在后台被冻住的那一阵，这条流多半已经死了 —— 别等退避，直接重接一条。 */
    func becameActive() {
        endBackgroundTask()
        if inBackground {
            inBackground = false
            start()
        } else if loop == nil || loop?.isCancelled == true {
            start()
        }
    }

    /**
     退到后台：向系统要一段宽限时间。这段时间里那条流还在跑，来得及的提醒照样弹；
     时间到了（系统冻住进程）就自然断了，回到前台由 becameActive 接回来。
     */
    func wentBackground() {
        inBackground = true
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "pichat-notice") { [weak self] in
            Task { @MainActor in self?.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // ------------------------------------------------------------------------
    // 提醒流（GET /phone-notice）
    // ------------------------------------------------------------------------

    /** 起一条新的连接循环（旧的那条先掐掉）。 */
    private func start() {
        loop?.cancel()
        loop = Task { [weak self] in await self?.runLoop() }
    }

    /** 连接循环：连 → 收 → 断了等一等 → 再连，一直转到这条 Task 被取消。 */
    private func runLoop() async {
        var backoff: UInt64 = 2
        while !Task.isCancelled {
            guard let base = server else {
                status = "还没填后端地址：在上面那格填一个，点「打开」"
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                continue
            }
            do {
                connected = false
                status = "连接中… \(base)"
                try await stream(base: base)
            } catch {
                if Task.isCancelled { return }
                status = "断开，\(backoff) 秒后重试（\(shortError(error))）"
                if connected { backoff = 2 }
            }
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
            if Task.isCancelled { return }
            backoff = min(backoff * 2, 60)
        }
    }

    /** 连上去、一行一行读 SSE，直到断了（抛出去）或者这条 Task 被取消。 */
    private func stream(base: String) async throws {
        guard let url = URL(string: base + "/phone-notice") else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (bytes, response) = try await http.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(httpResponse.statusCode)"])
        }
        connected = true
        status = "已连接 \(base)"
        var data = ""
        // SSE 一行一行读：data 行攒着，空行就是一条事件到齐了（event / retry / 注释都不管）
        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }
            if line.isEmpty {
                if !data.isEmpty {
                    handle(data)
                    data = ""
                }
            } else if line.hasPrefix("data:") {
                data = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            }
        }
        throw URLError(.networkConnectionLost)
    }

    /** 一条事件到齐了：认出是「有事」还是「收掉」，别的（hello、tick）不管。 */
    private func handle(_ data: String) {
        guard let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)),
              let message = json as? [String: Any] else { return }
        switch message["type"] as? String {
        case "notice":
            showNotice(message)
        case "close":
            if let sessionId = message["sessionId"] as? String, !sessionId.isEmpty {
                let center = UNUserNotificationCenter.current()
                let identifier = Self.noticePrefix + sessionId
                center.removeDeliveredNotifications(withIdentifiers: [identifier])
                center.removePendingNotificationRequests(withIdentifiers: [identifier])
            }
        default:
            break
        }
    }

    /** 弹一条会话提醒：点开就进 app 里看那个会话（见 PiChatApp 的 AppDelegate）。 */
    private func showNotice(_ message: [String: Any]) {
        let sessionId = message["sessionId"] as? String ?? ""
        let name = (message["name"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let title = name.isEmpty ? "会话" : name
        // 通知栏是纯文本：markdown 原样塞进去会带一堆星号井号，压成一行再截短
        let body = (message["text"] as? String ?? "")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        let text = String(body.prefix(Self.bodyChars))
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = text.isEmpty ? title : text
        content.sound = .default
        if !sessionId.isEmpty {
            content.userInfo = ["sessionId": sessionId]
            content.threadIdentifier = sessionId
        }
        // 编号用会话号：同一个会话的提醒换掉旧的，不同会话各占一条
        let identifier = sessionId.isEmpty ? UUID().uuidString : Self.noticePrefix + sessionId
        UNUserNotificationCenter.current()
            .add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    /** 那行字里放一句短话（完整的原因写太长，设置画面那一行放不下）。 */
    private func shortError(_ error: Error) -> String {
        if let urlError = error as? URLError {
            return urlError.localizedDescription
        }
        return error.localizedDescription
    }
}
