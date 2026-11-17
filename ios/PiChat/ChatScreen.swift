import Foundation
import SwiftUI
import WebKit

/**
 网页画面 —— 顶上一根窄条（写着「‹ 设置」，回设置画面用），底下整块是后端的对话页面。

 跟安卓那边一个意思：装的页面就是浏览器里那份，点通知进来直接带到那个会话上；
 页面本来就开着的时候不整页重来（那样会话列表、推送连接、滚动位置全重来），
 只在页面里切一格 —— 就是顶条上点一格那一下（`window.pichatSwitchSession`，见 WebPage）。

 安卓那边回设置是连按两下返回键（手机上没有返回键可用，所以这儿摆一颗明着的按钮）。
 */
@MainActor
struct ChatScreen: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Button {
                    model.showSettings()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                        Text("设置")
                    }
                    .font(.system(size: 16))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
            }
            .background(Color(.secondarySystemBackground))
            Divider()

            WebPage(base: model.server ?? "", session: model.sessionId)
        }
    }
}

/**
 后端的对话页面（一台 WKWebView）。

 包的这份页面就是后端给的那份，不发任何本地请求：地址换了就整页加载一遍；
 地址没换、只是要看另一个会话，就先问页面能不能自己切过去
 （`window.pichatSwitchSession` 返回 true 就是切好了），
 切不过去（页面还停在错误页、或者电脑上还是旧界面没有这颗接口）才退回整页加载。
 */
@MainActor
struct WebPage: UIViewRepresentable {
    let base: String
    let session: String?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: configuration)
        // 页面里左右划是用来切会话的（见 GLOSSARY 的「会话格」），别让系统顺手翻上一页
        web.allowsBackForwardNavigationGestures = false
        context.coordinator.web = web
        context.coordinator.show(base: base, session: session)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.web = web
        context.coordinator.show(base: base, session: session)
    }

    /// 记着页面上装的是哪个地址、哪个会话（整页重来只该发生在地址变了的时候）。
    @MainActor
    final class Coordinator {
        weak var web: WKWebView?
        private var loadedBase: String?
        private var loadedSession: String?

        func show(base: String, session: String?) {
            guard let web = web, !base.isEmpty else { return }
            if loadedBase != base {
                loadedBase = base
                loadedSession = session
                web.load(URLRequest(url: Self.url(base: base, session: session)))
                return
            }
            guard let session, !session.isEmpty, loadedSession != session else { return }
            loadedSession = session
            let script = "(function(){if(typeof window.pichatSwitchSession!=='function'){return false;}"
                + "window.pichatSwitchSession(\(Self.jsString(session)));return true;})()"
            web.evaluateJavaScript(script) { [weak self, weak web] result, _ in
                guard let self = self, let web = web else { return }
                // 回来的不是 true：页面还停在错误页上、或者是旧版界面 —— 退回整个加载一遍
                if (result as? Bool) == true { return }
                self.loadedSession = session
                web.load(URLRequest(url: Self.url(base: base, session: session)))
            }
        }

        /// 页面地址：`<后端>/`，带会话时再加 `?session=<号>`。
        static func url(base: String, session: String?) -> URL {
            var text = base + "/"
            if let session, !session.isEmpty,
               let escaped = session.addingPercentEncoding(withAllowedCharacters: unreserved) {
                text += "?session=" + escaped
            }
            return URL(string: text) ?? URL(string: base)!
        }

        /// 地址里那个会话号按 RFC 3986 只留不用转义的那些字符（跟 Java 的 URLEncoder 一个用意）。
        private static let unreserved = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

        /// 把一段字写成 JS 字面量（带上两头的引号、里面的引号与反斜杠转义好）。
        static func jsString(_ value: String) -> String {
            guard let data = try? JSONEncoder().encode(value),
                  let text = String(data: data, encoding: .utf8) else { return "\"\"" }
            return text
        }
    }
}
