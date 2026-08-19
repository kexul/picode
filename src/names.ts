/**
 * names —— tab / panel 的随机中文命名（"形容词的noun"，如"沉静的雪豹"）。
 *
 * 创建时一次性分配，之后永不变化：panel 名（pane-head）与 tab 栏派生名稳定可认。
 * tab 栏显示规则由宿主派生（见 chatControllerBase.containerDisplayName）：
 * 单 panel → 完整名；多 panel → 布局序名词以 "·" 拼接（形容词不参与）。
 */

export interface NameParts {
    adjective: string;
    noun: string;
}

const ADJECTIVES = [
    "沉静", "勇敢", "温柔", "灵巧", "明快", "沉稳", "活泼", "清澈", "温暖", "灵动",
    "悠然", "坚毅", "轻盈", "辽阔", "细腻", "恬静", "蓬勃", "皎洁", "绚烂", "澄澈",
    "从容", "机敏", "和煦", "静谧", "飒爽", "质朴", "烂漫", "苍翠", "丰茂", "清冽",
    "悠远", "明亮", "柔和", "矫健", "欢畅", "淡雅", "繁茂", "晶莹", "舒展", "坦荡",
    "灵秀", "朴素", "欢腾", "清越", "疏朗", "温润", "旷达", "葱茏", "朗润", "挺拔",
];

const NOUNS = [
    "雪豹", "白鹿", "青鸟", "云杉", "海棠", "山雀", "白鹭", "苍鹰", "水獭", "银杏",
    "白桦", "芦苇", "鸢尾", "铃兰", "丁香", "紫藤", "翠鸟", "夜莺", "黄鹂", "雨燕",
    "鸿雁", "天鹅", "鸳鸯", "云雀", "羚羊", "藏狐", "猞猁", "岩羊", "旱獭", "麋鹿",
    "红隼", "喜鹊", "戴胜", "锦鲤", "江豚", "海豚", "白鲸", "海豹", "珊瑚", "礁石",
    "苔原", "冰川", "峡谷", "溪流", "湖泊", "瀑布", "岛屿", "沙丘", "极光", "晨雾",
];

/** 随机生成名字的两部分（形容词 + 名词）。 */
export function randomNameParts(): NameParts {
    return {
        adjective: ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
        noun: NOUNS[Math.floor(Math.random() * NOUNS.length)],
    };
}

/**
 * 从全名池分配一个未使用名字。池耗尽后在完整名字后追加递增序号，
 * 因而即使同时打开超过 2500 个 panel 也不会重名。
 */
export function uniqueNameParts(used: ReadonlySet<string>): NameParts {
    const pairs = ADJECTIVES.length * NOUNS.length;
    const start = Math.floor(Math.random() * pairs);
    for (let step = 0; step < pairs; step++) {
        const index = (start + step) % pairs;
        const parts = {
            adjective: ADJECTIVES[Math.floor(index / NOUNS.length)],
            noun: NOUNS[index % NOUNS.length],
        };
        if (!used.has(composeName(parts))) { return parts; }
    }
    // 所有基础组合均在用：随机挑一个基础名，再为它找最小可用序号。
    const index = Math.floor(Math.random() * pairs);
    const adjective = ADJECTIVES[Math.floor(index / NOUNS.length)];
    const noun = NOUNS[index % NOUNS.length];
    for (let suffix = 2; ; suffix++) {
        const parts = { adjective, noun: `${noun} ${suffix}` };
        if (!used.has(composeName(parts))) { return parts; }
    }
}

/** 由两部分拼出完整显示名（"沉静的雪豹"）。 */
export function composeName(parts: NameParts): string {
    return `${parts.adjective}的${parts.noun}`;
}
