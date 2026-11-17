import SwiftUI

/**
 设置画面 —— 一列：地址输入框、一颗「打开」、用过的地址清单、一行连接状况、底下几句提示。
 跟安卓那个设置画面同一套东西，少了「包里这份界面旧没旧」和「打包并安装新版」两行：
 那两行靠的是 APK 自己带界面文件 + 能装未知来源的包，iOS 上两样都没有（见 ios/README.md）。

 手机上是一整列；iPad 上同一列摆在中间（最宽 560），两边留白。
 */
@MainActor
struct SettingsScreen: View {
    @EnvironmentObject private var model: AppModel

    /// 地址不像话时那句提示弹一下（看一眼就清掉）。
    private var complaint: Binding<Bool> {
        Binding(
            get: { model.complaint != nil },
            set: { model.complaint = $0 ? model.complaint : nil }
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Pi Chat")
                    .font(.system(size: 24, weight: .semibold))
                Text("填电脑上后端的地址（浏览器里打开的那个，比如 192.168.1.40:1867），"
                     + "点「打开」就连过去看对话。手机 / iPad 要跟电脑连同一个网络。")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                TextField("192.168.1.40:1867", text: $model.addressText)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { model.openAddress(model.addressText) }

                Button {
                    model.openAddress(model.addressText)
                } label: {
                    Text("打开").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                if !model.history.isEmpty {
                    Text("用过的地址")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                    ForEach(model.history, id: \.self) { address in
                        HStack(spacing: 8) {
                            Button {
                                model.openAddress(address)
                            } label: {
                                Text(address)
                                    .font(.system(size: 15, weight: address == model.server ? .semibold : .regular))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Button {
                                model.forget(address)
                            } label: {
                                Text("×")
                                    .font(.system(size: 20))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 32, height: 32)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 2)
                        Divider()
                    }
                }

                Text("连接：\(model.status)")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)

                Text("iOS 没有安卓那种常驻前台服务：app 一退到后台，系统过几秒就把它冻住，"
                     + "这条连接也跟着停，那段时间收不到提醒；回到 app 会自己接回来。"
                     + "点通知进来会直接开那个会话。\n"
                     + "第一次连局域网里的地址时系统会问「是否允许访问本地网络」，得点允许，"
                     + "不然连不上；通知不弹就去系统的「设置 → 通知 → Pi Chat」里看一眼。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemBackground))
        .alert("地址不像话", isPresented: complaint) {
            Button("知道了", role: .cancel) { model.complaint = nil }
        } message: {
            Text(model.complaint ?? "")
        }
    }
}
