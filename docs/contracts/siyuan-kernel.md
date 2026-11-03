# 思源内核 API 契约（冻结子集）

> 状态：**DOC-VERIFIED**（依据 siyuan-note/siyuan master `docs/API.zh-CN.md` 核对，2026-11-03）。真实内核行为（块更新 ID 保留、forwardProxy 实测等）见 `docs/capability-matrix.md`。
> 原则：只调用公开内核 API，不直接修改 .sy 或数据库；插件前端统一经 `siyuan` 包的 `request`（桌面/浏览器同路径，自动带内核鉴权）。

## 鉴权与通用

- 内核 HTTP API：`POST /api/<module>/<action>`，返回 `{code, msg, data}`；`code !== 0` 即失败。
- 插件内用 `siyuan` 包 `request(url, data, options)` 调用，桌面与浏览器共用同一实现。

## 网络正向代理（浏览器端外联关键能力）

`POST /api/network/forwardProxy`

```json
{
  "url": "https://i.weread.qq.com/api/agent/gateway",
  "method": "POST",
  "timeout": 15000,
  "contentType": "application/json",
  "headers": [{ "Authorization": "Bearer ***" }],
  "redirect": true,
  "payload": { "api_name": "/user/notebooks", "count": 20, "skill_version": "1.0.5" },
  "payloadEncoding": "json",
  "responseEncoding": "text"
}
```

- `headers` 是**对象数组**（逐个合并键值对）。
- 返回 `data`: `{ body, bodyEncoding, contentType, elapsed, headers, status, url }`；`status` 为目标服务 HTTP 状态码。
- 响应体上限 32 MiB（超限 code=10）；本插件载荷远小于此。
- 用途：唯一白名单远端外联通道，规避浏览器 CORS；桌面端同样走此通道以共享核心逻辑。

## 块操作（T02+ 使用，先冻结语义）

- `POST /api/block/updateBlock` `{ dataType: "markdown"|"dom", data, id, lockType? }`：原位更新；返回 doOperations。`lockType=true` 时解析后块类型与原块不同则拒绝。
- `POST /api/block/insertBlock` `{ dataType, data, previousID }` / `appendBlock` `{ dataType, data, parentID }` / `prependBlock`：插入新块。
- `POST /api/block/deleteBlock` `{ id }`。
- `POST /api/block/getBlockKramdown` `{ id }` → `data.kramdown`。
- `POST /api/block/getChildBlocks` `{ id }`。
- `POST /api/attr/setBlockAttrs` `{ id, attrs: { "custom-xxx": "..." } }`；`getBlockAttrs` `{ id }`。自定义属性命名空间 `custom-`。
- `POST /api/query/sql` `{ sql }` → `data` 数组（如 `select * from blocks where ...`）。
- `POST /api/filetree/createDocWithMd` `{ notebook, path, markdown }` → `data` 为新文档 ID；**同 path 重复调用不覆盖已有文档**；`/` 是层级分隔符，标题含 `/` 须先转全角 `／`。建议新代码优先 `createDocByParent`（父身份+标题分开传递）。
- `POST /api/filetree/renameDoc` `{ notebook, path, title }`。
- `POST /api/notebook/createNotebook` `{ name }`；`/api/notebook/lsNotebooks` 列出。
- `POST /api/system/version` → 内核版本号。

## 已知边界（不得越界承诺）

- 公开 updateBlock **无文档化 CAS**；不承诺严格零竞态，写前重读 + 写后回读是本插件的核对手段（T02/T03 实现并测试）。
- SQL 索引存在性不是唯一事实源；存在性证据以块 ID 回读为准。
