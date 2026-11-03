# T04 原生阅读总览、自动块引用与统一美观样式设计契约（冻结）

> Task #5（delegate 模式）。依赖 #3 已合并（f364497）。主代理冻结；实现由子代理 F 承担。

## 1. 投影模型（不建第二套事实源）

- 总览文档"00 阅读总览"：位于"微信读书"笔记本根部，**按 custom-wrs-overview="1" 属性唯一标识**（不以标题绑定；标题仅展示）。缺失时创建（空 markdown + 属性），已存在时原位维护。
- 总览结构（全部为**可独立更新的稳定子块**，绝不整篇重写）：
  - `# 00 阅读总览`（文档标题，创建时给定）
  - 时长摘要文本块（attr custom-wrs-section="stats"；T05 填充真实数据，本任务建槽位与"暂无统计数据"占位文本）
  - 书籍清单容器（attr custom-wrs-section="books"）：**每书一个稳定清单条目块**（attr custom-wrs-entry="<bookId>"），内容 = `((<书籍文档ID> '书名'))` 思源**原生动态块引用** + 进度/状态标签文本。条目按 bookId 增量增删改，ID 不变（AC1/AC2）。
  - 最近摘录容器（attr custom-wrs-section="recent"）：最近 N=5 条摘录的**动态块引用**（引用既有 highlight 锚点块 ID，`((<blockId> '摘要…'))`，不复制正文，AC2）。
  - 用户复盘区（attr custom-wrs-section="notes"）：创建时置一段提示文本"此处为你的自由复盘区，插件不会修改本区块内容"——**投影永不触碰**（AC3）。
- 单书页增强：文档头插入（或更新）一个元数据块（attr custom-wrs-section="bookmeta"，内容=封面图 `![](cover)`+作者+进度+同步状态小字）；章节摘录与用户区不动。书 meta 块按属性定位原位更新；**只更新这一个自有块**。
- 停用可读（AC4）：以上全部是原生 kramdown 内容（动态引用、文本、图片），无 HTML/iframe，插件停用后仍完整可读。

## 2. 更新纪律（复用 T02/T03 机制）

- 所有总览/元数据写入走既有 SiyuanWriter + 意图先行（oplog intent 增 "project"）→ 回读核对 → 记账；失败安全停。
- 条目/引用块更新用 updateBlock（用户批准范围外的例外裁决：总览是**插件自有投影块**（custom-wrs-section/entry 属性标识），非用户正文；仅允许更新**带插件投影属性**的块，更新前回读校验属性归属，属性不符 → 跳过+上报，绝不碰无属性块（AC3 反向污染防护）。
- 重建路径：总览丢失按属性 SQL 找回；找不到则重建骨架（用户复盘区随之重建为占位——如实上报"复盘区曾被删"）。

## 3. 样式

- src/index.scss 增插件作用域类（.weread-note-sync-* 前缀，仅插件面板用）；原生笔记内容**零注入 CSS**（动态引用渲染由思源原生处理）。设置页/审阅对话框风格延续 var(--b3-*)。
- 清单条目文本格式统一：`书名 · 作者 · 进度% · [在读|读完]`，克制强调色不用红绿表状态（符号+文字）。

## 4. 触发与数据

- syncRound 成功轮末尾（书状态保存后）触发 `projectOverview(engine 内部)`：更新各书 meta 块 + 总览清单/最近摘录；index 增 overviewDocId 缓存（可由属性重建）。
- 进度/读完：notebooks overview 的 readingProgress/markedStatus；封面/作者：书 doc meta（T02 payload）。时长摘要：本任务仅占位（T05 接 `/readdata/detail`）。

## 5. AC 对照
- AC1 幂等：重复同步清单条目数=书数、条目 ID 稳定；改名书文档（内容改名不改 ID）不影响绑定。
- AC2 清单动态引用真实可跳转（FakeKernel 断言 markdown 含 ((id ...)) 结构）；摘录引用既有锚点不复制正文。
- AC3 复盘区/用户区域跨轮逐字不变（测试锁定）；无属性块零触碰。
- AC4 全部内容为原生 kramdown（无 HTML/iframe/自定义 CSS 注入笔记）。
- AC5 样式 scoped（svelte-check+grep 锁定）；空态/长书名/错误态可读（文本截断策略：清单条目书名截 40 字符加 …）。
