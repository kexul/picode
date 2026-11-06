/**
 * tailscalePeers —— 从 Tailscale 的节点列表里找出同一 tailnet 里跑着 Pi Chat 的那几台。
 *
 * 为什么不是 UDP 广播 / mDNS：Tailscale 的隧道是三层点对点的，没有广播域，
 * 255.255.255.255 与 5353 组播都只在本机网卡上打转，到不了对端节点。
 * 但 `tailscale status --json` 能列出整个 tailnet 的节点和它们的 100.x 地址，
 * 挨个探一下 `/health`，返回里 app 是 pichat 的就知道那台开着 Pi Chat。
 *
 * 探到的接进 chatHost 的 remotePeers（见 startPeerDiscovery）：之后定时去拉它的
 * `/phone/sessions`，列表里就会出现那台现在开着的会话 —— 不依赖它有没有推送过通知。
 */
import { execFile } from "child_process";

export interface DiscoveredPeer {
    /** 那台机器的名字（Tailscale 里那个 HostName）。 */
    label: string;
    /** 它的 Tailscale 地址（100.x）。 */
    address: string;
    /** 它的网页服务地址（`http://100.x:端口`，不带末尾斜杠）。 */
    pageUrl: string;
}

/** 探一次 /health 最多等这么久：网断了就当它不是。 */
const PROBE_TIMEOUT_MS = 2500;
/** `tailscale status` 最多等这么久（它偶尔会磨一下）。 */
const STATUS_TIMEOUT_MS = 4000;
/** 出厂端口：这台不知道对方改没改端口，先按出厂的试（见 README 的 51883）。 */
const DEFAULT_PORT = 51883;

/** tailscale 这个命令可能在哪：先看环境变量，再看各平台的常见安装位置，最后靠 PATH。 */
function tailscaleCandidates(): string[] {
    const out: string[] = [];
    const env = process.env.TAILSCALE_PATH;
    if (env) { out.push(env); }
    if (process.platform === "win32") {
        out.push(
            "C:\\Program Files\\Tailscale\\tailscale.exe",
            "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
        );
    } else if (process.platform === "darwin") {
        out.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    }
    out.push("tailscale");
    return out;
}

function runStatus(bin: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(bin, ["status", "--json"], {
            timeout: STATUS_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
        }, (err, stdout) => {
            resolve(err ? undefined : stdout);
        });
    });
}

/** 找一台装了 tailscale 的机器问一次节点列表；没装（或者不是 tailnet 成员）就是 undefined。 */
async function statusJson(): Promise<string | undefined> {
    for (const bin of tailscaleCandidates()) {
        const text = await runStatus(bin);
        if (text && text.trim().startsWith("{")) { return text; }
    }
    return undefined;
}

/** 把 `tailscale status --json` 里的节点挑出来：只要在线的、有 IPv4 的、不是自己的。 */
function nodesFrom(json: string): Array<{ label: string; address: string }> {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return []; }
    if (!parsed || typeof parsed !== "object") { return []; }
    const obj = parsed as { Self?: unknown; Peer?: unknown };
    const self = new Set(ipv4Of(obj.Self));
    const out: Array<{ label: string; address: string }> = [];
    const peers = obj.Peer;
    if (!peers || typeof peers !== "object") { return out; }
    for (const value of Object.values(peers as Record<string, unknown>)) {
        if (!value || typeof value !== "object") { continue; }
        const peer = value as { HostName?: unknown; DNSName?: unknown; Online?: unknown; TailscaleIPs?: unknown };
        // 老版本没有 Online 这个字段：那就当它在线，探一下 /health 自然知道
        if (peer.Online === false) { continue; }
        const ips = ipv4Of(peer);
        const address = ips.find((ip) => !self.has(ip));
        if (!address) { continue; }
        const hostName = typeof peer.HostName === "string" ? peer.HostName.trim() : "";
        const dnsName = typeof peer.DNSName === "string" ? peer.DNSName.split(".")[0] : "";
        out.push({ label: hostName || dnsName || address, address });
    }
    return out;
}

/** 节点上的 IPv4 地址（TailscaleIPs 里 100.x 那一批）。 */
function ipv4Of(node: unknown): string[] {
    if (!node || typeof node !== "object") { return []; }
    const list = (node as { TailscaleIPs?: unknown }).TailscaleIPs;
    if (!Array.isArray(list)) { return []; }
    return list.filter((ip): ip is string => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip));
}

/** 探一下这个地址上是不是 Pi Chat；是的话顺便把它自己报的名字带回来（设置里那个「叫它什么」）。 */
async function probe(origin: string): Promise<{ ok: boolean; name?: string }> {
    try {
        const res = await fetch(origin + "/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) { return { ok: false }; }
        const body = (await res.json()) as { app?: unknown; name?: unknown };
        if (body?.app !== "pichat") { return { ok: false }; }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        return name ? { ok: true, name } : { ok: true };
    } catch {
        return { ok: false };
    }
}

/**
 * 找一遍：同一 tailnet 里现在跑着 Pi Chat 的那几台（不含自己）。
 * 没装 tailscale、不在 tailnet 里、节点都探不通，就给空数组（调用方当没有就行）。
 */
export async function discoverTailscalePeers(port = DEFAULT_PORT): Promise<DiscoveredPeer[]> {
    const json = await statusJson();
    if (!json) { return []; }
    const nodes = nodesFrom(json);
    if (nodes.length === 0) { return []; }
    const found: DiscoveredPeer[] = [];
    await Promise.all(nodes.map(async (node) => {
        const pageUrl = `http://${node.address}:${port}`;
        const probed = await probe(pageUrl);
        if (!probed.ok) { return; }
        // 那台自己报的名字（设置里「推到那边时叫它什么」）优先：列表里看到的跟推送来的一致
        found.push({ label: probed.name ?? node.label, address: node.address, pageUrl });
    }));
    return found;
}
