/**
 * 插件代码一开始加载（require）就记下时间点，给 extension.ts 里的启动计时用。
 * 必须放在 extension.ts 第一个 import，数字才准：它后面 import 的文件加载多久，
 * 都能从“加载插件代码”这一行里看出来。
 */
export const bootMark = performance.now();
