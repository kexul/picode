// 这个文件是 dev/askDialog.js 用的触发开关，平时不生效（也不是插件的一部分）。
// 要跑那个测试时：把它复制到 ~/.pi/agent/extensions/ ，跑完把复制过去的那份删掉。
// 玩法：页面上发一句 "test-prompt" 或 "test-confirm"，就弹对应的框，答复写成一条系统提示。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("input", async (event, ctx) => {
        const text = event.text.trim();

        if (text === "test-confirm") {
            const ok = await ctx.ui.confirm(
                "回滚修改",
                "文件在这次修改后又被改动过，回滚将丢弃那些后续变更。\n确定继续？",
            );
            ctx.ui.notify(ok ? "确认框答复：确定" : "确认框答复：取消");
            return { action: "handled" };
        }

        if (text === "test-prompt") {
            const written = await ctx.ui.input("自己写答案（选 A 还是 B？）", "把答案写在这里");
            ctx.ui.notify(written === undefined ? "输入框答复：（取消）" : `输入框答复：${written}`);
            return { action: "handled" };
        }

        // 普通的“选一个”（别的扩展也会用的那种：不是 ask_choice，走 pi 自己那套 select）
        if (text === "test-select") {
            const picked = await ctx.ui.select("选一个颜色", ["红灯", "绿灯", "黄灯"]);
            ctx.ui.notify(picked === undefined ? "选择列表答复：（取消）" : `选择列表答复：${picked}`);
            return { action: "handled" };
        }

        return;
    });
}
