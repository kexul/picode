// 调试用：往后端的 /notify 塞一条“别的机器推来的有事”，看右下角那张卡片弹得对不对
// 用法：node dev/remoteNote.mjs [地址] [kind]
//   不给地址就用 http://127.0.0.1:51999（npm run web:dev / server 起在本机时）
//   kind 写 ask 就是「等你答一句」那种
const url = (process.argv[2] || "http://127.0.0.1:51999").replace(/\/+$/, "");
const kind = process.argv[3] === "ask" ? "ask" : "done";
const base = {
    label: "家里那台",
    name: "会话·静静的风",
    sessionId: "s1",
    pageUrl: url,
};
const body = kind === "ask"
    ? { ...base, text: "要我把这两条测试也一起提交吗？", kind: "ask" }
    : { ...base, text: "跑完了，我把那段重试逻辑改成了指数退避，顺便补了两条测试。", kind: "done" };
const res = await fetch(url + "/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
});
console.log(res.status, await res.text());
