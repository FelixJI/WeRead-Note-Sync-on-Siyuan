# 微信读书官方 Agent API Gateway 契约（冻结）

> 状态：**DOC-VERIFIED + MOCK-TESTED**（依据官方技能契约文档核对，并以脱敏 Mock 契约测试覆盖；真实联调证据见 `docs/capability-matrix.md` 的 UNVERIFIED 条目）。
> 来源：微信读书官方技能契约（Tencent/WeChatReading skills，skill_version 1.0.5）。

## 统一入口

- `POST https://i.weread.qq.com/api/agent/gateway`（唯一白名单远端，不开放任意 Base URL）
- Header：`Authorization: Bearer $WEREAD_API_KEY`（Key 格式 `wrk-` 前缀）、`Content-Type: application/json`
- Body：JSON，业务参数**平铺在顶层**，与 `api_name`、`skill_version` 同级；禁止包在 `params`/`data`/`body` 对象里
- 每次请求必须带 `"skill_version": "1.0.5"`

```json
{ "api_name": "/user/notebooks", "count": 20, "lastSort": 1778312777, "skill_version": "1.0.5" }
```

## 响应通用规则

- JSON；`errcode` 非 0 表示错误（中文 `errmsg` 提示）。
- 回包出现 `upgrade_info` 字段时：**立即暂停操作**，按 `upgrade_info.message` 指引升级后重试；实现层必须抛 `UpgradeRequiredError` 而非忽略。
- 时间戳字段（`updateTime`/`createTime`/`finishTime`/`readUpdateTime`）为 Unix 秒；展示转 `YYYY-MM-DD`。
- 阅读时长字段一律**秒**；展示转“X小时Y分钟”。

## 本插件使用的接口

| api_name | 用途 | 分页 | 关键参数（大小写敏感） |
| --- | --- | --- | --- |
| `/user/notebooks` | 有笔记书目概览 | `count`（默认 20）+ `lastSort` 游标；`hasMore`=1 时取本页最后一条 `sort` 作下一页 `lastSort` | `count`, `lastSort` |
| `/book/bookmarklist` | 单书划线内容（自动过滤书签，仅划线 type=1） | 无分页（单次全量） | `bookId`（驼峰） |
| `/review/list/mine` | 单书个人想法/点评 | `synckey` + `count`（默认 20）；`hasMore`=1 时回包 `synckey` 作下页游标 | **`bookid`（全小写，与上表不同！）**, `synckey`, `count` |
| `/book/info` | 书籍信息（书名/作者/封面/ISBN/简介） | 无 | `bookId` |
| `/book/getprogress` | 阅读进度；`book.progress` 0-100 整数（1=1%，仅 100 为读完）；`recordReadingTime` 累计秒 | 无 | `bookId` |
| `/readdata/detail` | 阅读统计；`mode`=weekly/monthly/annually/overall；`baseTime` 归一到周期起点；`totalReadTime` 秒 | 无 | `mode`, `baseTime` |

### 字段要点（易误读，实现不得凭直觉）

- `/user/notebooks`：`books[].noteCount` 是**划线数**（不是总笔记数）；总笔记数 = `reviewCount + noteCount + bookmarkCount`；`reviewCount` 已含个人点评，勿重复加。
- `/book/bookmarklist`：`updated[].bookmarkId` 划线唯一 ID；`chapters[]` 提供章节定位；`type`/`range`/`colorStyle` 可选。
- `/review/list/mine`：`reviews[].review.reviewId` 唯一 ID；`abstract`（对应划线原文）与 `range` 是**条件字段**（整本书评/章节点评可能缺失）；`star` -1..5。
- `/readdata/detail`：总量口径用 `totalReadTime`；`readTimes` 仅明细/交叉校验；`dayAverageReadTime` 分母是自然日不是阅读天数；`dailyReadTimes` 年度日明细（可选返回）；`annually` 的 `readTimes` 按**月**分桶，不得当日桶用。

## 分页安全规则（T01 AC3 冻结）

1. 游标只用于翻页，**不是可靠增量版本**；同步决策不依据游标值。
2. 游标不前进（下一页 `lastSort`/`synckey` 等于上一页）→ 判定游标循环，**停止并报 `PaginationAnomalyError`**，不得当作“已完成”。
3. 整页重复（与上一页 bookId/reviewId 集合相同）→ 记录异常并停止。
4. 同一官方 ID 在不同页出现且载荷不同 → 保留首个、记录 `ambiguousId` 异常，交上层裁决。
5. 必填字段缺失（如 books[].bookId、reviews[].review.reviewId）→ 跳过该条并记录异常，不猜主键。
6. 鉴权失败（HTTP 401 / errcode 鉴权类）→ 抛 `AuthError`，不创建任何文档，提示用户检查 Key。
7. 分页中途失败 → 本轮数据**不完整**，不得标记来源删除或推进任何基线（T02 依赖此语义）。
