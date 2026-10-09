import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    ALLOWED_MEDIA_FILES,
    MessageBuffer,
    contentTypeOf,
    isAllowedMediaFile,
    isLoopbackHostHeader,
    isLoopbackName,
    isSameOrigin,
    isWildcardHost,
    localHostnames,
    PageChannels,
} from "./webTransport";

test("media 资源白名单：只要名单内的文件，且不允许带路径", () => {
    for (const name of ALLOWED_MEDIA_FILES) {
        assert.equal(isAllowedMediaFile(name), true, `${name} 应该允许`);
    }
    assert.equal(isAllowedMediaFile("../package.json"), false);
    assert.equal(isAllowedMediaFile("..\\package.json"), false);
    assert.equal(isAllowedMediaFile("sub/chat.js"), false);
    assert.equal(isAllowedMediaFile("chat.js/../../x"), false);
    assert.equal(isAllowedMediaFile(".hidden.js"), false);
    assert.equal(isAllowedMediaFile("index.html"), false);
    assert.equal(isAllowedMediaFile(""), false);
    assert.equal(isAllowedMediaFile("a\0b.js"), false);
});

test("资源类型：按扩展名给，未知扩展名当纯文本", () => {
    assert.match(contentTypeOf("chat.js"), /javascript/);
    assert.match(contentTypeOf("chat.css"), /text\/css/);
    assert.match(contentTypeOf("a.png"), /image\/png/);
    assert.match(contentTypeOf("CHAT.JS"), /javascript/);
    assert.match(contentTypeOf("weird"), /text\/plain/);
    assert.match(contentTypeOf("chat.js"), /charset=utf-8/);
});

test("本机地址判断", () => {
    assert.equal(isLoopbackName("127.0.0.1"), true);
    assert.equal(isLoopbackName("localhost"), true);
    assert.equal(isLoopbackName("LOCALHOST"), true);
    assert.equal(isLoopbackName("::1"), true);
    assert.equal(isLoopbackName("[::1]"), true);
    assert.equal(isLoopbackName("0.0.0.0"), false);
    assert.equal(isLoopbackName("192.168.1.5"), false);
    assert.equal(isLoopbackName(""), false);
});

test("Host 头检查：本机的几种写法都放行，端口要对，别的域名拒绝", () => {
    assert.equal(isLoopbackHostHeader("127.0.0.1:51833", 51833), true);
    assert.equal(isLoopbackHostHeader("localhost:51833", 51833), true);
    assert.equal(isLoopbackHostHeader("[::1]:51833", 51833), true);
    assert.equal(isLoopbackHostHeader("127.0.0.1", 51833), true);
    // 端口不对：域名重绑定时会拿别的端口来试探
    assert.equal(isLoopbackHostHeader("127.0.0.1:8080", 51833), false);
    assert.equal(isLoopbackHostHeader("evil.example.com:51833", 51833), false);
    assert.equal(isLoopbackHostHeader("192.168.1.5:51833", 51833), false);
    assert.equal(isLoopbackHostHeader("evil.example.com", 51833), false);
    assert.equal(isLoopbackHostHeader(undefined, 51833), false);
    assert.equal(isLoopbackHostHeader("", 51833), false);
    assert.equal(isLoopbackHostHeader("[::1", 51833), false);
});

test("监听地址是否是“所有网卡”的通配写法", () => {
    assert.equal(isWildcardHost("0.0.0.0"), true);
    assert.equal(isWildcardHost("::"), true);
    assert.equal(isWildcardHost(""), true);
    assert.equal(isWildcardHost("127.0.0.1"), false);
    assert.equal(isWildcardHost("192.168.1.5"), false);
});

test("本机地址名单：本机写法总在，绑定具体地址时它也在里面", () => {
    const names = localHostnames("192.168.1.5");
    for (const wanted of ["localhost", "127.0.0.1", "::1", "192.168.1.5"]) {
        assert.ok(names.includes(wanted), `名单里应该有 ${wanted}`);
    }
    assert.ok(!localHostnames("0.0.0.0").includes("0.0.0.0"), "通配写法本身不是可访问的地址");
});

test("Origin 检查：不带 Origin 放行，本服务自己的页面放行，别的网站拒绝", () => {
    const own = ["localhost", "127.0.0.1", "::1"];
    assert.equal(isSameOrigin(undefined, 51883, own), true, "命令行工具不带 Origin，放行");
    assert.equal(isSameOrigin("http://127.0.0.1:51883", 51883, own), true);
    assert.equal(isSameOrigin("http://localhost:51883", 51883, own), true);
    assert.equal(isSameOrigin("http://127.0.0.1:51884", 51883, own), false, "本机别的端口也不行");
    assert.equal(isSameOrigin("http://evil.example.com:51883", 51883, own), false, "别的网站里的脚本发来的请求不行");
    assert.equal(isSameOrigin("https://127.0.0.1:51883", 51883, own), false, "https 那个地址不是本服务的页面");
    assert.equal(isSameOrigin("not a url", 51883, own), false);
    // 手机用局域网地址打开本服务的页面：Origin 就是那个地址
    const lan = localHostnames("0.0.0.0");
    const lanAddress = lan.find((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name) && !name.startsWith("127."));
    if (lanAddress) {
        assert.equal(isSameOrigin(`http://${lanAddress}:51883`, 51883, lan), true, "手机那份页面的请求要放行");
    }
    assert.equal(isSameOrigin("http://10.9.8.7:51883", 51883, lan), false, "别人的地址不行（除非真的在这台机器上）");
});

test("消息缓冲：顺序不变，满了丢最老的，取走后清空", () => {
    const box = new MessageBuffer(3);
    box.push({ type: "a" });
    box.push({ type: "b" });
    box.push({ type: "c" });
    assert.equal(box.size, 3);
    box.push({ type: "d" });
    assert.equal(box.size, 3, "超过上限后仍只保留上限条数");
    const drained = box.drain();
    assert.deepEqual(drained.map((m) => m.type), ["b", "c", "d"], "最老的那条被丢掉");
    assert.equal(box.size, 0, "取走后缓冲是空的");
    box.push({ type: "e" });
    box.clear();
    assert.equal(box.size, 0, "清空后什么都没有了");
});

test("页面连接登记簿：几个页面同时连着，谁也不是唯一的", () => {
    const closed: string[] = [];
    const sent: string[] = [];
    const pages = new PageChannels();
    const send = (id: string) => (msg: Record<string, unknown>) => sent.push(`${id}:${String(msg.type)}`);

    const { channel: phone } = pages.add("p-phone", send("p-phone"), (note) => closed.push(`phone:${note}`));
    const { channel: pc } = pages.add("p-pc", send("p-pc"), (note) => closed.push(`pc:${note}`));
    assert.equal(pages.size, 2, "两个页面同时连着");

    // 广播：每个页面都收到
    let reached = 0;
    pages.forEach((page) => { reached += 1; page.send({ type: "hello" }); });
    assert.equal(reached, 2);
    assert.deepEqual(sent, ["p-phone:hello", "p-pc:hello"]);

    // "最近有人在动过"的那个：确认框发给它
    assert.equal(pages.recent()?.id, "p-pc", "刚连上来的那个算最近");
    pages.beat("p-phone");   // 报活只算还活着，不算人在动
    assert.equal(pages.recent()?.id, "p-pc", "报活不该把确认框抢走");
    pages.touch("p-phone", true);
    assert.equal(pages.recent()?.id, "p-phone", "人真的在里面动了才算");

    // 一个页面走了：另一个继续收消息，"最近"落到还连着的那个上
    pages.remove("p-phone");
    assert.equal(pages.size, 1);
    assert.equal(pages.recent()?.id, "p-pc");
    pages.remove("p-pc");
    assert.equal(pages.recent(), undefined, "一个都没连着");
    assert.deepEqual(closed, [], "登记簿自己不关连接，关连接是调用方的事");
});

test("登记簿：同一个页面又连一次（重连）会把旧那条交回来，不发“被顶掉”那种提示", () => {
    const closed: string[] = [];
    const pages = new PageChannels();
    const first = pages.add("p-phone", () => {}, (note) => closed.push(`first:${note}`));
    assert.equal(first.replaced, undefined, "头一条连接没有谁被顶下来");

    const second = pages.add("p-phone", () => {}, (note) => closed.push(`second:${note}`));
    assert.ok(second.replaced, "同一个页面标识又来了一条：旧的要交回给调用方");
    assert.equal(pages.size, 1, "登记簿里始终只有这一条");
    second.replaced!.close("");
    assert.deepEqual(closed, ["first:"], "重连不用跟旧连接道别（告别话是空的）");
});

test("登记簿：服务发出过的页面标识，断开之后发来的消息也还算数", () => {
    const pages = new PageChannels(2);
    pages.markIssued("p-one");
    assert.equal(pages.isKnown("p-one"), true, "刚取走页面、推送连接还没连上，也算数");
    assert.equal(pages.isKnown("p-two"), false, "从没见过的标识不算");

    const two = pages.add("p-two", () => {}, () => {});
    assert.equal(pages.isKnown("p-two"), true, "连上了当然算数");
    pages.remove("p-two");
    assert.equal(pages.isKnown("p-two"), true, "断开了、正在重连：仍然算数（手机回到前台那一下就靠它）");

    pages.add("p-three", () => {}, () => {});
    assert.equal(pages.isKnown("p-three"), true);
    assert.equal(pages.isKnown("p-one"), false, "名单有长度上限，最老的会被挤掉");
    void two;
});

test("登记簿：半天没动静的连接挑得出来（服务据此掐掉死连接）", () => {
    let now = 0;                 // 时钟自己推，不用真的等一分钟
    const pages = new PageChannels(32, () => now);
    pages.add("p-a", () => {}, () => {});
    pages.add("p-b", () => {}, () => {});

    now = 6_000;
    pages.beat("p-a");           // 手机那条还在报活，另一条从连上就没动静了
    now = 10_000;
    assert.deepEqual(pages.staleIds(5_000), ["p-b"], "刚报过活的挑不出来，一直没动静的挑得出来");

    now = 12_000;
    assert.deepEqual(pages.staleIds(5_000), ["p-a", "p-b"], "再往后两条都算死了");
    assert.deepEqual(pages.staleIds(60_000), [], "上限给得宽就谁都不算死");
});
