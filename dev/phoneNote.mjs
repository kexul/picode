// 调试用：往后端的 /notify 塞一条“别的机器推来的有事”（app 收到会弹通知）
// 用法：node dev/phoneNote.mjs [地址] [kind]
const url = (process.argv[2] || "http://127.0.0.1:51999").replace(/\/+$/, "");
const kind = process.argv[3] === "ask" ? "ask" : "done";
const body = kind === "ask"
    ? {
        label: "家里那台",
        name: "会话·静静的风",
        sessionId: "s1",
        text: "要我把这两条测试也一起提交吗？",
        kind: "ask",
    }
    : {
        label: "家里那台",
        name: "会话·静静的风",
        sessionId: "s1",
        text: "跑完了，我把那段重试逻辑改成了指数退避，顺便补了两条测试。",
        kind: "done",
    };
const res = await fetch(url + "/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
});
console.log(res.status, await res.text());
