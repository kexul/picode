# Issue tracker：本地 markdown

这个仓库的 issue 和 spec 都是 markdown 文件，放在 `.scratch/` 里（不进版本库）。

## 约定

- 一个功能一个目录：`.scratch/<功能名>/`
- spec 是 `.scratch/<功能名>/spec.md`
- 要动手做的活，一个 ticket 一个文件：`.scratch/<功能名>/issues/<NN>-<短名>.md`，从 `01` 编号；
  不要把所有 ticket 挤在一个文件里
- 分诊状态写在每个 issue 文件靠上的 `Status:` 那一行（用哪几个词见 `triage-labels.md`）
- 对话、评论追加到文件末尾的 `## Comments` 标题下面

## 技能说「发到 issue tracker」时

在 `.scratch/<功能名>/` 下新建一个文件（目录不存在就建）。

## 技能说「取出相关的 ticket」时

读那个路径的文件。用户一般会直接把路径或编号给你。

## 找路（`/wayfinder` 用）

一张 **map** 配一堆 **子 ticket** 文件。

- **Map**：`.scratch/<这件事>/map.md`，里面写 Notes、目前定了哪些、还没想清的。
- **子 ticket**：`.scratch/<这件事>/issues/NN-<短名>.md`，从 `01` 编号，正文写要回答的问题。
  `Type:` 那行记类型（`research` / `prototype` / `grilling` / `task`）；
  `Status:` 那行记 `claimed`（已认领）/ `resolved`（已解决）。
- **谁挡住谁**：文件靠上写一行 `Blocked by: NN, NN`。它列的文件全都 `resolved` 了，这个 ticket 才算解开。
- **下一件该做的**：扫 `.scratch/<这件事>/issues/`，挑没做完、没人挡着、没人认领的，编号最小的先做。
- **认领**：动手前先写 `Status: claimed` 存下来。
- **收工**：答案追加到 `## Answer` 标题下面，`Status:` 改成 `resolved`，再把这次的结论
  （一句话加指向）追加到 `map.md` 的「目前定了哪些」里。
