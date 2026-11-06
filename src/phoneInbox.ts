/**
 * phoneInbox —— 手机 / 桌上那个小窗口看到的那些「有事」。
 *
 * 以前手机上只弹一下：那会儿没连上、手机退到后台，这条就没了。现在那边要当成一串话看
 * （这一轮说了什么、模型在等你答哪一道题），所以后端得留一份：每个会话留最近若干条，
 * 一连上先把这一份给它，之后来一条推一条。
 *
 * 只活在内存里：后端重启就没了。手机上少几条旧话不算事，会话本身一点不受影响。
 */

/** 一条「有事」是哪一种：跑完一轮 / 在等你答一句 / 你自己说的一句话。 */
export type PhoneNoteKind = "done" | "ask" | "me";

/** 模型问的那道题（只有 kind 是 ask 时才有）。 */
export interface PhoneAsk {
    /** 卡片编号：答这道题时要把它带回来（见 webChatServer.ts 的 /phone/answer）。 */
    cardId: string;
    options: string[];
    /** 能不能勾多个（false = 单选）。 */
    multi: boolean;
    /** 推荐项的下标（从 1 数起），没推荐就是空数组。 */
    recommended: number[];
    /** 要不要「自己写」那一行。 */
    allowText: boolean;
}

/** 留着的一条「有事」。 */
export interface PhoneNoteRecord {
    /** 全局递增：手机靠它排先后、也靠它认出「这条我见过」。 */
    seq: number;
    sessionId: string;
    /** 那个会话叫什么（列表上那一行、以及只剩通知没有会话时用它）。 */
    name: string;
    kind: PhoneNoteKind;
    text: string;
    /** 什么时候的事（毫秒）。 */
    at: number;
    /** 别的机器推来的：那台叫什么。 */
    from?: string;
    ask?: PhoneAsk;
    /** 这道题已经答过 / 收掉了：界面上把那几个选项置灰（重新连上时看到的也是置灰的）。 */
    settled?: true;
}

/** 一条要记下来的东西（编号与时刻由这里补上）。 */
export interface PhoneNoteInput {
    sessionId: string;
    name: string;
    kind: PhoneNoteKind;
    text: string;
    at?: number;
    from?: string;
    ask?: PhoneAsk;
}

/** 每个会话留着的那一串「有事」。 */
export class PhoneInbox {
    /** 一个会话留几条（多了丢最旧的）。 */
    public static readonly KEEP = 20;

    private readonly notes = new Map<string, PhoneNoteRecord[]>();
    private seq = 0;

    /** 记一条下来，返回记下的那一条（编号是新的）。 */
    public add(note: PhoneNoteInput): PhoneNoteRecord {
        const record: PhoneNoteRecord = {
            seq: ++this.seq,
            sessionId: note.sessionId,
            name: note.name,
            kind: note.kind,
            text: note.text,
            at: note.at ?? Date.now(),
            ...(note.from ? { from: note.from } : {}),
            ...(note.ask ? { ask: note.ask } : {}),
        };
        const list = this.notes.get(record.sessionId) ?? [];
        list.push(record);
        if (list.length > PhoneInbox.KEEP) { list.splice(0, list.length - PhoneInbox.KEEP); }
        this.notes.set(record.sessionId, list);
        return record;
    }

    /** 这个会话留着的那些（旧的在前面）。 */
    public list(sessionId: string): PhoneNoteRecord[] {
        return this.notes.get(sessionId) ?? [];
    }

    /** 这个会话最后一条（列表上那一行要显示的那句）。 */
    public last(sessionId: string): PhoneNoteRecord | undefined {
        const list = this.notes.get(sessionId);
        return list && list.length > 0 ? list[list.length - 1] : undefined;
    }

    /** 现在留着哪些会话的（列表要补上「这台已经没有那个会话、只剩通知」的那几个）。 */
    public sessionIds(): string[] {
        return Array.from(this.notes.keys());
    }

    /** 这道题已经答过了：把留着的那条标上（再连上来就是置灰的）。 */
    public markAskDone(cardId: string): void {
        for (const list of this.notes.values()) {
            for (const record of list) {
                if (record.ask && record.ask.cardId === cardId) { record.settled = true; }
            }
        }
    }

    /** 不在这些会话里的都丢掉（关掉的会话别越攒越多）。 */
    public prune(alive: Set<string>): void {
        for (const id of Array.from(this.notes.keys())) {
            if (!alive.has(id)) { this.notes.delete(id); }
        }
    }

    /** 全都丢掉（服务停的时候）。 */
    public clear(): void {
        this.notes.clear();
    }
}
