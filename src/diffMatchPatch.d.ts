/**
 * src/diffMatchPatch.js（照抄的 Google diff-match-patch）里我们真正用到的那几个方法。
 *
 * 那个文件是原来的 JS，没改一个字，所以类型写在这儿。用到的都是「比一段文字」这一半，
 * 打补丁那一半（patch_*）没用上，就不写进来了。
 */
declare class diff_match_patch {
    /**
     * 两份文字的差异：一串 `[操作, 文字]`，操作是 -1（删）/ 1（加）/ 0（没变）。
     * @param checklines 大的文字先按行比一遍再逐行细比（我们比的是同一行的两段，用不上）
     */
    diff_main(text1: string, text2: string, checklines?: boolean, deadline?: number): Array<[number, string]>;
    /** 整理一遍：把「改了一个字母」那种碎块并成人看着顺眼的一段段（同一段里挪动边界）。 */
    diff_cleanupSemantic(diffs: Array<[number, string]>): void;
    /** 一串差异换算成「改了多少个字」。 */
    diff_levenshtein(diffs: Array<[number, string]>): number;
}

export = diff_match_patch;
