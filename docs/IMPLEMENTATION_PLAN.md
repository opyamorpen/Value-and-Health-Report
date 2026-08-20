# ONES 客户价值与应用健康度插件 — 详细实施计划

> 依据：根目录 `README.md`（权威规格）、`TEST_ENVIRONMENT.md`（测试实例）、`REPOSITORY.md`（协作流程）。
> 验收基线：私有部署 ONES v7.22.0。本计划于 2026-08-20 批准执行。

## 一、目标与交付物

交付一个 ONES Open Platform 2.0 Hosted App（`ones-node-22`，NestJS 后端 + React/Vite 前端）。CSM 在工作台按周期（默认近 90 天 vs 前 90 天）生成不可变报告快照，产出：

- **客户价值报告**：项目 / Sprint / Issue / 交付周期 / 协作 / 计划兑现 等团队级聚合结论。
- **应用健康度报告**：全产品矩阵按能力维度展示成熟度（`未配置` / `已配置未活跃` / `活跃使用` / `形成闭环`），另设 `未购买` / `不适用` / `无法核验`（三者不参与成熟度判断）。
- **增购机会建议**：未购模块不计入健康度，单独生成机会建议。
- **客户版 PDF**：CSM 核验并编辑叙事后，按确认板块导出。

最终交付：版本化 `.opkx` 包，且 README「实施与验收」10 步全部通过。

## 二、关键技术决策

| 决策点 | 结论 |
| --- | --- |
| 运行时与交付 | `ones-node-22` Hosted App；`ones build` 产出版本化 `.opkx`（如 `dist/customer-value-health-v1.0.0.opkx`）；每次打包前先递增 `opkx.json` 的 `app.version`，保留历史包 |
| 2.0 CLI | **项目本地安装**（已确认）：脚手架阶段用 `npx @ones-open/cli create …` 引导，随后固定为 devDependency，日常经 `npx ones …` / npm scripts 调用；不改动全局 1.0 CLI（本机 v1.70.61） |
| 工作台入口 | `appSettingPages` 扩展（≥6.88，每 app 最多 1 个 provider）：后端实现 POST `customEntries` 返回 200 + 页面入口 |
| 前端调用 | 页面内只用 `ONES.fetchApp()` 调自家后端、`ONES.getTeamInfo()/getUserInfo()` 取上下文；沙箱禁用 localStorage/sessionStorage/cookie，状态一律存后端 |
| 后端 OpenAPI | App Identity：`@ones-open/node-sdk` 的 `oauth.getAccessTokenByInstallationInfo(installationInfo)`（省略 userID）；直连 `<ones_base_url>/openapi/v2/...`；token 缓存 + 过期刷新 |
| 存储 | `storage.entity`（安装信息、白名单、规则版本、任务、快照、审计）+ `storage.object`（PDF）；`where()` 查询必须先声明索引；单次查询上限 1000 条、实体写超时 15s |
| 异步任务 | 进程内 job runner + 实体存储状态机（pending/running/partial/failed/succeeded），可恢复、幂等；同团队+周期+规则版本去重 |
| PDF | 服务端确定性模板：pdfkit + 内嵌 CJK 字体子集，趋势图矢量绘制；产物入 Object Storage，导出按需签发预签名下载 URL（1 小时有效期） |
| 安全 | 生命周期回调 JWT 校验（base64 解码 shared_secret、HS256、aud=appId、sub=installationId、含 rsh 则重算）；密钥原子轮换；白名单鉴权；审计日志；绝不记录/提交任何凭据 |

## 三、里程碑与工作分解（映射 README 验收步骤 1–10）

### M0 工具链与环境准备

- `npx @ones-open/cli` 引导 CLI，验证 2.x 版本及 `build/dev/app` 命令存在。
- `npx ones login https://demo-plugin.ones.pro`（浏览器授权），`npx ones whoami` 确认。
- 若支持 `ones specs`：拉取本地 OpenAPI/Hosted API/schema 契约到 `.ones/ones-app-specs`。
- 产出：可用工具链 + 登录态 + 本地契约。

### M1 证据矩阵（验收步骤 1）——硬门禁

用登录态浏览器（TEST_ENVIRONMENT.md 凭据）+ API 探测，产出 `docs/evidence-matrix.md`：

- 公共 OpenAPI：project、sprint、issue、changelog（含 10,000 条截断行为）、comment、manhour、wiki、测试用例库、授权、ONESQL——逐端点记录路径、分页、限流表现、scope、业务权限。
- `appSettingPages` manifest 嵌套结构（对照 `schemas/extensions/app-setting-pages-*.json`）。
- OAuth scope 清单与权限模型（如何取团队负责人/组织管理员身份，支撑白名单）。
- v7.22.0 内部接口：代码集成、流水线、自动化、Desk、Assistant、Performance——通过页面行为 + 网络请求确认合同。
- 确认测试实例是否具备「无代码仓」「有代码仓+关联提交/MR」两类样本团队（步骤 6 前置）。
- **门禁规则：矩阵中无证据的探测器不得进入实现（约束 M4）。**

### M2 脚手架与工程基线

- `npx @ones-open/cli create` 创建脚手架（保留现有文档），CLI 固定为 devDependency。
- `opkx.json`：app 信息、runtime、未鉴权 healthcheck、四个 lifecycle callback、`oauth.scope`（按 M1）、`ones.storage`（entity+object）、`appSettingPages`。
- 后端骨架：health 路由；install/enabled/disabled/uninstalled 回调（JWT 校验、幂等、time_stamp 拒旧、shared_secret 原子写入）。
- `npx ones dev --install` 隧道联调，验证回调与 healthcheck。
- Git：`feat/scaffold` → PR → CI → squash 合并。
- 产出：能 dev 安装启用的空应用。

### M3 纵向切片（验收步骤 2）——首个可验收交付

后端模块：

- `installation`：安装信息 + JWT guard + App Identity token 服务。
- `openapi-client`：分页遍历、429 退避、401/403 分类、截断标记、覆盖率。
- `collectors`：Project / Sprint / Issue / 协作（changelog、评论、工时），机器人过滤。
- `metrics`：ruleVersion 化团队级聚合——项目、Sprint 终态按期、Issue 创建/首完/重开/吞吐、P50/P75 交付周期（样本不足→未知）、协作周趋势、计划兑现率。
- `jobs`：创建去重、异步执行、进度、局部成功、失败原因、重试。
- `reports`：五个 API（`POST /api/report-jobs`、`GET /api/report-jobs/{id}`、`GET /api/reports/{id}`、`PATCH /api/reports/{id}/narrative`、`POST /api/reports/{id}/exports`、`GET /api/reports/{id}/evidence`）。
- `pdf`：pdfkit 模板 → Object Storage。
- `audit` 与白名单最小实现。

前端工作台页：周期选择与生成、进度轮询、报告查看（价值/健康/机会）、叙事编辑、PDF 预览确认与导出。

**验收：测试实例真实团队生成一份快照，页面查看 + PDF 下载成功。**

### M4 CapabilityDetector 与全产品矩阵（验收步骤 3）

- 探测器框架：声明 version、依赖权限、响应 schema 校验、降级规则；漂移/校验失败 → `无法核验`，绝不静默推断为未配置。
- 按 M1 矩阵实现 12 个能力维度探测器与成熟度规则。
- 未购模块 → 独立增购机会，不影响健康度。

### M5 正确性与韧性测试（验收步骤 4、5）

- 固定数据单测：跨周期对比、首次完成、重开、终态 Sprint、机器人过滤、时区边界、缺失值、样本不足。
- 韧性测试：分页、限流、401、scope 403、业务权限 403、接口漂移、部分失败、重复任务、变更日志截断。

### M6 双团队验收与安全测试（验收步骤 6、7、8）

- 两类样本团队验收：接口不可用 ≠ 未配置。
- 未购模块不降健康度。
- 越权测试、数据不出域检查、PDF 脱敏（隐藏内部错误/销售备注/人员明细）、删除与卸载清理。

### M7 打包与最终验收（验收步骤 9、10）

- 单元/集成/PDF 视觉回归/构建测试全绿；`ones build` 版本化 `.opkx`；App Center 安装/更新、启用。
- 生命周期/JWT、OpenAPI、探测器、存储、页面刷新持久化、PDF 下载、生产日志（`npx ones app logs`）。
- 登录态浏览器完成真实 ONES 页面验收。

## 四、存储设计

实体集合（初版）：`installations`、`permission_whitelist`、`rule_versions`、`report_jobs`、`report_snapshots`、`narrative_revisions`、`audit_logs`、`export_revisions`（M4 增 `detector_results`）。

所有结果统一携带 `status` / `source` / `collectedAt` / `coverage` / `confidence` / `ruleVersion`。先建索引再写查询。

## 五、贯穿性工程约束

- Git（REPOSITORY.md）：分支 → push → PR → CI 绿 → squash 合并；`TEST_ENVIRONMENT.md` 永不入库。
- 里程碑粒度 = PR 粒度，完成即推送。
- 安全红线：不记录/提交 shared_secret、token、cookie；页面与 PDF 不出现个人贡献排行。

## 六、风险与前置条件

1. CLI 冲突已决策（项目本地 + npx 引导）。
2. 内部接口合同依赖登录态浏览器抓包；部分能力可能只能得出「无法核验」——属产品预期的安全降级，但会收窄 M4 范围。
3. 双样本团队若缺失需先在测试实例造数据（M1 期间确认）。
4. Hosted runtime 的 CPU/内存/长任务限额文档未载明 → M2/M3 实测校准（job 分片 + 可恢复设计已预留）。
5. 安装回调 10s 超时、实体查询 1000 条/次、预签名 URL 1 小时有效期均已纳入设计约束。
