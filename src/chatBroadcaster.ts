import {
    PAGE_TRANSIENT_MESSAGE_TYPES,
    type PageChannel,
    PageChannels,
} from "./webTransport";

/**
 * ChatBroadcaster —— 插件里的对话面板与浏览器页面共用的消息出口。
 *
 * 会话编排（ChatControllerBase）往外推的每条消息从这里发给所有"页面"：
 * 插件里那份对话面板走 postMessage（不走这里），浏览器页面走网页服务的推送流。
 * 网页可以同时连着好几个（手机 + 电脑），推的消息发给每一个；
 * 每条实时消息记一个递增序号并进补发暂存，页面重连后按序号补拉漏掉的消息。
 *
 * 这里不碰网络：往连接里写、把连接关掉，都是网页服务传进来的函数
 * （与 webTransport.PageChannels 同一个思路）。
 */

/** 补发暂存的默认条数：超过先丢最老的（丢了就补不上，只能整屏重画）。 */
const CATCHUP_LOG_ENTRIES = 2000;
/** 补发暂存的默认字节数（消息里可能带大图，光按条数不可靠）。 */
const CATCHUP_LOG_BYTES = 8 * 1024 * 1024;

/** 登记一条连接的结果：新连接、被顶下来的旧连接（页面自己重连时才有）、hello 带的序号。 */
export interface ChannelAddResult {
    channel: PageChannel;
    /** 同一个页面标识又连了一次：之前那条，调用方安静地关掉它。 */
    replaced?: PageChannel;
    /** 本条连接建立时的序号：hello 发它，页面靠它分清实时与补发。 */
    openSeq: number;
}

export class ChatBroadcaster {
    private readonly pages = new PageChannels();
    /** 推给页面的消息序号：每广播一条加一。页面靠它报「我处理到第几条」。 */
    private seqCounter = 0;
    /** 最近广播的消息（重连补发用）。序号连续；一次性消息只占位不补发（msg 为 null）。 */
    private readonly catchupLog: Array<{ seq: number; bytes: number; msg: Record<string, unknown> | null }> = [];
    private catchupLogBytes = 0;
    private readonly catchupLogEntries = CATCHUP_LOG_ENTRIES;
    private readonly catchupLogBytesLimit = CATCHUP_LOG_BYTES;
    /** 页面当前这条推送连接建立时的序号：比它大的都是这条连接的实时消息。 */
    private readonly openSeqByPage = new Map<string, number>();

    // ========================================================================
    //  连接登记（网页服务的推送连接从这里进出）
    // ========================================================================

    /**
     * 登记一条推送连接。
     * 同一个页面标识连了第二次（页面重连）：旧连接从 returned.replaced 交给调用方安静收掉。
     */
    public addChannel(
        id: string,
        send: (msg: Record<string, unknown>) => void,
        close: (note: string) => void,
    ): ChannelAddResult {
        const { channel, replaced } = this.pages.add(id, send, close);
        // 这条连接建立时的序号。比它大的消息都会写给这条连接（实时消息）；
        // 页面手里更老的序号对应的是断线期间漏掉的，重连后由它报数、这里补发。
        // hello 必须走在一切带序号的消息前面：页面靠它分清实时和补发。
        const openSeq = this.seqCounter;
        this.openSeqByPage.set(id, openSeq);
        return { channel, replaced, openSeq };
    }

    /**
     * 注销一条连接（页面走了 / 死连接被掐掉 / 积压太多）。
     * 传连接对象不传标识：同一个页面重连后标识没变，旧连接迟到的 close 事件
     * 不能把重连后的新连接误删掉——只有“登记簿里还是这一条”时才真的注销。
     */
    public removeChannel(channel: PageChannel): void {
        if (this.pages.get(channel.id) !== channel) { return; }
        this.pages.remove(channel.id);
        this.openSeqByPage.delete(channel.id);
    }

    public getChannel(id: string): PageChannel | undefined {
        return this.pages.get(id);
    }

    public hasPage(pageId: string): boolean {
        return this.pages.has(pageId);
    }

    public forEachChannel(fn: (channel: PageChannel) => void): void {
        this.pages.forEach(fn);
    }

    /** 注销全部连接（停服务时用）。返回被注销的那些，调用方去关连接。 */
    public removeAllChannels(): PageChannel[] {
        this.openSeqByPage.clear();
        this.lastActionAt.clear();
        return this.pages.removeAll();
    }

    /** 记下"这个标识是本服务发出的"：页面刚取走、推送流还没连上时，它的消息也要收下。 */
    public markIssued(id: string): void {
        this.pages.markIssued(id);
    }

    /** 这个页面标识能不能收发消息（连着，或本服务发出过）。 */
    public isKnown(id: string): boolean {
        return this.pages.isKnown(id);
    }

    /** 页面标识 → 人最后一次在里面做动作的时刻（报活不算，见 touch）。 */
    private readonly lastActionAt = new Map<string, number>();

    /** 记一笔"这个页面有动静"。报活不算动作（不然后台页面一直抢着当“最近在动的那个”）。 */
    public touch(id: string, userAction: boolean): void {
        this.pages.touch(id, userAction);
        if (userAction) { this.lastActionAt.set(id, Date.now()); }
    }

    /** 只更新"还活着"的时刻（页面报活）。 */
    public beat(id: string): void {
        this.pages.beat(id);
    }

    /** 超过 maxAgeMs 没有任何动静的页面标识（连接多半已经死了）。 */
    public staleIds(maxAgeMs: number): string[] {
        return this.pages.staleIds(maxAgeMs);
    }

    /** 最近有人在里面动过的那个页面（确认框、选项浮层发给它）；一个都没连着时 undefined。 */
    public recentPage(): PageChannel | undefined {
        return this.pages.recent();
    }

    /**
     * 人最后一次做动作的页面与时刻（报活不算动作）。
     * 确认框弹到哪个页面、还是弹回 VSCode，靠它与插件里对话面板的最近动静比新旧。
     */
    public recentActionPage(): { id: string; at: number } | undefined {
        let best: { id: string; at: number } | undefined;
        for (const [id, at] of this.lastActionAt) {
            if (!this.pages.has(id)) { continue; }
            if (!best || at > best.at) { best = { id, at }; }
        }
        return best;
    }

    // ========================================================================
    //  发消息
    // ========================================================================

    /**
     * 发给所有连着的页面，并给消息记上一个递增的序号（哪怕当时一个页面都没连着）。
     * 一个页面都没连着返回 false（调用方先把消息攒着）；
     * 但序号和补发暂存都照记：页面重连后就是靠这些序号补拉漏掉的消息的。
     */
    public broadcast(msg: Record<string, unknown>): boolean {
        const seq = ++this.seqCounter;
        msg.seq = seq;
        this.rememberForCatchup(seq, msg);
        let any = false;
        this.pages.forEach((channel) => { any = true; channel.send(msg); });
        return any;
    }

    /** 只发给一个页面（整屏重画 / 补发时用）。这类消息不带序号、不进补发暂存。 */
    public sendTo(pageId: string, msg: Record<string, unknown>): boolean {
        const channel = this.pages.get(pageId);
        if (!channel) { return false; }
        channel.send(msg);
        return true;
    }

    /** 当前的消息序号（整屏重画完让页面对齐到这个位置，下次重连它报的数才是准的）。 */
    public currentSeq(): number {
        return this.seqCounter;
    }

    /**
     * 页面重连后补发它错过的消息。
     *
     * @param lastSeq 页面报上来的「我处理到的最后一个序号」。
                断线期间广播出去的消息序号都记在暂存里，把 (lastSeq, 这条连接建立时的序号]
                这一段补给它，再发一条 syncPoint 告诉它「补齐到第几条了」。
     * @returns true 表示已经办好（补了该补的，或本来就一条不缺）；
     *          false 表示补不了（页面不在了，或缺得太多暂存里已经没有）——调用方退回整屏重画。
     */
    public catchUp(pageId: string, lastSeq: number): boolean {
        if (!Number.isFinite(lastSeq) || lastSeq < 0) { return false; }
        const channel = this.pages.get(pageId);
        const openSeq = this.openSeqByPage.get(pageId);
        if (!channel || openSeq === undefined) { return false; }
        if (lastSeq >= openSeq) { return true; }   // 一条不缺，什么都不用补
        const oldest = this.catchupLog.length > 0 ? this.catchupLog[0].seq : undefined;
        // 暂存里的序号是连续的；最老的那条比页面报的还新，说明中间缺的已经丢了，补不全
        if (oldest === undefined || oldest > lastSeq + 1) { return false; }
        for (const entry of this.catchupLog) {
            if (entry.seq <= lastSeq) { continue; }
            if (entry.seq > openSeq) { break; }
            if (entry.msg) { channel.send(entry.msg); }
        }
        channel.send({ type: "syncPoint", seq: openSeq });
        return true;
    }

    /**
     * 把刚广播的一条消息记进补发暂存。
     * 「一次性消息」（确认框、浮层这类）只占个序号位不存内容：它们不补发（见 webTransport 的名单）。
     * 超过条数或字节上限就从最老的开始丢；丢了的那段补不上，页面只能整屏重画。
     */
    private rememberForCatchup(seq: number, msg: Record<string, unknown>): void {
        const transient = typeof msg.type === "string" && PAGE_TRANSIENT_MESSAGE_TYPES.has(msg.type);
        let bytes = 0;
        if (!transient) {
            try { bytes = Buffer.byteLength(JSON.stringify(msg), "utf8"); } catch { bytes = 0; }
        }
        this.catchupLog.push({ seq, bytes, msg: transient ? null : msg });
        this.catchupLogBytes += bytes;
        while (
            this.catchupLog.length > this.catchupLogEntries
            || (this.catchupLogBytes > this.catchupLogBytesLimit && this.catchupLog.length > 1)
        ) {
            const dropped = this.catchupLog.shift();
            if (!dropped) { break; }
            this.catchupLogBytes -= dropped.bytes;
        }
    }
}
