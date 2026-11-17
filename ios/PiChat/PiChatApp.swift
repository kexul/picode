import SwiftUI
import UIKit
import UserNotifications

/**
 两屏之间切的根：`showChat` 为假是设置画面，为真是一个 WebView 装着的对话页面
 （跟安卓那边 MainActivity 一个摆法：没有导航栈、没有标签条）。
 */
@MainActor
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.showChat {
                ChatScreen()
            } else {
                SettingsScreen()
            }
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active:
                model.becameActive()
            case .background:
                model.wentBackground()
            default:
                break
            }
        }
    }
}

@main
@MainActor
struct PiChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
        }
    }
}

/**
 AppDelegate —— 只为两件事来的（别的都在 SwiftUI 那层）：

 1. 要通知权限、并且让通知在 app 开着的时候也弹横幅 / 发出声音（默认是不弹的）；
 2. 人点了一条通知：带着那条的会话号切到网页画面那个会话上（见 AppModel.openSession）。
 */
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // 不给也行：流照连，只是不弹通知（跟安卓那边 POST_NOTIFICATIONS 的规矩一样）
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let sessionId = response.notification.request.content.userInfo["sessionId"] as? String,
           !sessionId.isEmpty {
            Task { @MainActor in AppModel.shared.openSession(sessionId) }
        }
        completionHandler()
    }
}
