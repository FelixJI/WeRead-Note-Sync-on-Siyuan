# Goal #1 GAC→证据对应表与 UNVERIFIED-LIVE 汇总（T06）

> 生成：2026-11-03。Mock/真实区分纪律：本表只引用可追溯的 PR/CI/测试证据；所有需要真实环境（真实 Key、真实思源内核、桌面/浏览器客户端）的项集中列于 §2，**取证前相应 GAC 不判 LIVE**。

## 1. GAC → 证据对应表

| GAC | 结论 | 证据 |
| --- | --- | --- |
| GAC1 配置→独立笔记本→每书文档→唯一汇总→重复同步无重复 | MOCK-TESTED（AC1 全绿） | PR#8/#9；tests/sync/engine.test.ts AC1×2、t04 AC1；CI run 41636194602 |
| GAC2 独改/均改/移位/改名/删除/拆合保护；锚点不删建；双链指向原 ID | MOCK-TESTED | PR#9（moved-out/user-deleted/unseen/歧义隔离 5 例）；PR#10（AC2 锚点跨轮稳定） |
| GAC3 五种 diff 决策持久化；保留本地同版本不重复打扰；不覆盖 | MOCK-TESTED | PR#10（keep-local 去重、stale 拒绝、中断三分支收养/重议/隔离） |
| GAC4 故障注入无盲目重建/删除/错误基线推进 | MOCK-TESTED | PR#9（四切断点+双世代损坏保护+复制属性）；PR#10（pendingUpdate 重入+身份校验） |
| GAC5 总览动态引用/统计文本/热力图快照正确；单位/日桶/时区/闰年；失败不破坏笔记 | MOCK-TESTED（真实环境视觉 UNVERIFIED） | PR#11（AC1-AC4）；PR#12（340 测试：单位/四态/闰年/冷却） |
| GAC6 桌面+浏览器闭环；深浅色/窄屏；停用可读；移动端原生阅读 | 代码路径就绪；**真实端到端 UNVERIFIED-LIVE** | 桌面/浏览器共用 fetchSyncPost+forwardProxy（PR#8）；停用可读=全原生 kramdown（PR#11 AC4 测试）；截图/操作证据待真实环境 |
| GAC7 单写入端/状态分叉保护/升级恢复；无秘密泄露；MIT | 单写入端 MOCK-TESTED；升级恢复=双世代+意图先行机制（PR#9）+UNVERIFIED 清单；秘密扫描=CI 零密钥依赖+脱敏测试（PR#8） | 本 PR writer-guard 4 例；docs/capability-matrix 全程三态标注 |
| GAC8 SHA/证据/审阅可追溯；PR 合并不替代组合验收 | 本表即组合验收记录；各 PR 均经独立审阅（T02/T04/T05 首轮 FAIL→整改→PASS） | PR#8/#9/#10/#11/#12 及其审阅评论 |

## 2. UNVERIFIED-LIVE 清单（T06 汇总；用户环境实测后逐项转 LIVE 或修复）

1. **真实网关连通**（有效/无效 Key 连接测试、鉴权 errcode 集合、upgrade_info 实况）——T01 移交。
2. **块更新语义**：updateBlock 原位更新后 ID/属性/引用保留（T02 §8 假设）；含 T03 用户批准路径的 ID 稳定性（FakeKernel 不可证伪）。
3. **IAL 出生绑定与回读形态**：创建 markdown 尾随 IAL 绑定到块并写入 blocks.ial；getBlockKramdown 回读=写入正文逐字一致、IAL 位于尾部；**块引用标签实体转义形态**（T04 MAJOR-1 依据 Lute 源码推断，已写入端规避）；AutoSpace 行为；**stats 栅栏+IAL 同行语义**（T05）。
4. **内核 SQL 行为**：blocks.ial LIKE+ESCAPE 与 SQLite 语义一致性（T02 M3 假设）。
5. **网关统计字段**：dailyReadTimes/readTimes key 形态（UTC 日秒）、readDays/totalReadTime、readingProgress(0-100)/markedStatus(1=读完)、/book/getprogress 字段（T04/T05 矩阵）。
6. **桌面/浏览器端插件加载与端到端闭环**（GAC6）：设置页/同步/审阅/统计对话框/停用后可读、深浅色/窄屏截图。
7. **localStorage 密钥存储按端行为**（T01）。
8. **账号命名空间服务端身份字段探测**（`/_list` 等；无则维持用户显式标签）。

## 3. 打包与许可

- `npm run make-package`：dist → package.zip（思源安装包；脚本不发布——发布需用户另行授权）。
- MIT LICENSE 在仓库根部；全链路零第三方代码复制（模板结构参照+官方 typings），无第三方许可清单需求。

## 4. 结论

**首版代码级目标达成**：6 任务全部按门禁合并（每任务 CI 绿+独立审阅 PASS）；GAC1-GAC5、GAC7（守卫/秘密/MIT）、GAC8 以 Mock 证据成立；**GAC6 端到端与 §2 全部 8 项待真实环境实测后 Goal 方可整体 ACCEPTED**——按 Goal 合同"Mock、真实隔离内核、真实官方只读调用和未测试项必须明确区分"，本表为区分后的如实组合验收记录。
