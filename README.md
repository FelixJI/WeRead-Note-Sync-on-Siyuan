# WeRead-Note-Sync-on-Siyuan

Reliable WeRead-to-SiYuan note synchronization with stable block mapping, diff review, and reading statistics.

将「微信读书」的划线、想法（笔记）与阅读统计可靠地同步到「思源笔记」：以稳定块映射保证重复同步不重建引用，以待审 diff 默认不覆盖你的正文，并附带阅读时长/进度统计。

## 项目简介

- 数据源：微信读书**官方 Agent API Gateway**（`https://i.weread.qq.com/api/agent/gateway`，Bearer `wrk-` Key）。
- 写入通道：思源笔记**公开内核 API**（不直接改 `.sy` 文件或数据库）。
- 当前版本（T01）交付：插件壳、设置页（API Key 管理 + 连接测试）、构建与 CI；笔记拉取与写入按任务分期推进（见 [docs/capability-matrix.md](docs/capability-matrix.md)）。

## 安全边界

- **官方 API only**：只调用微信读书官方 Agent API Gateway 与思源公开内核 API；不使用 Cookie、逆向接口、扫码抓取凭证、全文下载。
- **网络白名单**：唯一远端地址为上述网关；不提供自定义 Base URL 输入，任何请求不得越过白名单。
- **API Key 处理策略**：
  - 默认仅保存在**会话内存**（插件实例私有字段，插件重载/禁用即清空）；
  - 仅当你勾选「记住 API Key」时，才以**明文**写入本机 `window.localStorage`（键名 `weread-note-sync.apiKey`）：按端本地存储（桌面/浏览器各自独立）、非加密、不随思源内核同步，取消勾选或点击「清除 Key」即删除；
  - Key 绝不出现在仓库、日志、console、诊断包或截图等任何提交内容中；日志输出前经脱敏模块处理。
- **远端文本安全**：微信读书返回的一切文本在界面中以纯文本插值展示、在笔记中以转义/kramdown 处理，绝不作为可执行 HTML 注入。
- **CI/测试无真实凭证**：CI 与测试不依赖真实 Key；真实联调只能在你的本地输入。

## 开发

要求 Node >= 24。

```bash
npm install        # 安装依赖
npm run check      # tsc --noEmit + svelte-check
npm test           # vitest（契约测试，无真实网络）
npm run build      # 产出 dist/（index.js、index.css、plugin.json、i18n/、icon.png、README.md）
npm run dev        # watch 构建（开发调试）
```

构建产物目录 `dist/` 即为标准思源插件包结构，可直接将其放入思源 `conf/plugins/` 或打成 zip 安装。

## 思源插件开发参考

- 官方模板：[siyuan-note/plugin-sample-vite-svelte](https://github.com/siyuan-note/plugin-sample-vite-svelte)（本仓库脚手架参照其简化而来）
- 思源内核 API 文档：[SiYuan Kernel API (zh-CN)](https://github.com/siyuan-note/siyuan/blob/master/API_zh_CN.md)
- 插件系统说明：[siyuan-note/siyuan · Plugin](https://github.com/siyuan-note/siyuan/blob/master/README.md#plugin)
- 类型定义：npm 包 [`siyuan`](https://www.npmjs.com/package/siyuan)（devDependency，仅类型）

## 能力验证状态

能力矩阵与验证状态（`MOCK-TESTED` / `DOC-VERIFIED` / `UNVERIFIED-LIVE` 三级）见 **[docs/capability-matrix.md](docs/capability-matrix.md)**。如实说明：以下能力当前为 `UNVERIFIED-LIVE`（需真实凭证或真实内核环境，尚未实测）——真实网关连通性（有效/无效 Key）、思源块原位更新后 ID/属性/引用保留、思源 localStorage 按端存储行为；在取得证据前，相关能力不进入自动路径。

## License

[MIT](LICENSE)
