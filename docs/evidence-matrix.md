# 证据矩阵（M1）

> 目标实例：https://demo-plugin.ones.pro（实测版本 **v7.22.1**，验收基线 v7.22.0 的演示环境）
> 组织 UUID：`MVUtevnf`；验证账号：`wangshaobo@ones.cn`（组织管理员）
> 采集日期：2026-08-20（登录态浏览器实测）
> 配套文档：`docs/health-standard.md`（健康度标准）

## 样本团队

| 团队 | UUID | 规模 | 代码集成状态 | 用途 |
| --- | --- | --- | --- | --- |
| CSM-实施DEMO库 | `CXBRmzxd` | 63 人 | 关联 1 个 SVN 仓库「1213」（2025-05-15），周期内无关联提交/MR | 「已配置未活跃」样本（验收步骤 6 的 A 面） |
| 客户成功-演示团队 | `VAVx7WoU` | 71 人 | 2 个 GitLab 仓库（ones-test / ones-test2），7 条提交、3 个 MR；工作项 GCSX-7982 有 5 条关联提交 + 1 个关联 MR | 「活跃使用」样本（验收步骤 6 的 B 面） |

## A. 公共 OpenAPI（优先数据源）

契约来源：`.ones/ones-app-specs/openapi-spec.yaml`（2026-08-13 官方包，SHA256 `f9b72c71…`）。

**M2 已用 App Identity 实测（2026-08-20，应用 `app_09b374c462ec4d64` @ demo-plugin.ones.pro v7.22.1）**：下表 ✅ 端点均已通过 App token 实测返回 200 与正确数据结构。

| 编号 | 端点 | 用途 | 关键约束 | scope | 实测 |
| --- | --- | --- | --- | --- | --- |
| O-A1 | `GET /openapi/v2/project/projects` | 项目列表 | `limit` 默认 50、上限 100（超出截断）；`cursor` 分页；**项目 UUID 在 `id` 字段（非 uuid）** | `read:project:project` | ✅（limit=100 返回 100 条） |
| O-A2 | `GET /openapi/v2/project/projects/{projectID}/sprints` | Sprint 列表 | **不支持分页/过滤**；返回全部可见未删除 Sprint | `read:project:sprint` | ✅（T11 确认 scope 可用） |
| O-A3 | `GET /openapi/v2/project/issues` | 工作项列表 | `limit` 上限 100；仅支持 `projectID+issueTypeID` 联合过滤，**无日期过滤**（周期统计靠 ONESQL/changelog） | `read:project:issue` | ✅（经 issue-detail 端点验证） |
| O-A4 | `POST /openapi/v2/project/issueFields/changeLog/query` | 变更日志 | 按 issue 分页（`cursor+limit`，limit 上限 1000）；`issue_uuids` 必填，单批 ≤ 1000；返回记录上限 **10000，超出时 `records_truncated=true`**；机器人记录的 author.name 为 `{{system_bot}}`（可直接识别） | `read:project:issueField` | ✅（GCSX-7982 返回完整变更记录） |
| O-A5 | `GET /openapi/v2/project/workLog/timesEstimated` | 团队级预估工时 | `limit` 上限 100；支持 `startDate/endDate`（YYYY-MM-DD）、`userID`、`issueID` | `read:project:workLog-timeEstimated` | 待 M3 |
| O-A6 | `GET /openapi/v2/project/issues/{issueID}/workLog/simple/timesSpent` | 工作项登记工时 | `limit` 上限 100 | `read:project:issue-timeSpent` | 待 M3 |
| O-A7 | `GET /openapi/v2/wiki/spaces` | Wiki 空间 | 支持 `requestUserID`（OAuth bot 代指定用户） | `read:wiki:space` | 待 M3 |
| O-A8 | `GET /openapi/v2/wiki/spaces/{spaceID}/pages`、`GET /openapi/v2/wiki/pages/{pageID}` | Wiki 页面 | — | `read:wiki:page` | 待 M3 |
| O-A9 | `GET /openapi/v2/testcase/libraries` | 测试用例库 | `limit` 上限 100 | `read:testcase:library` | 待 M3 |
| O-A10 | `GET /openapi/v2/account/users/search`、`/account/users/batch`、`/account/users/thirdparty/binding/batch` | 用户与第三方绑定 | `limit` 上限 100 | `read:account:user` | 待 M3 |
| O-A11 | `GET /openapi/v2/license/apps` | 组织购买应用 | **需组织管理员**；返回 appID/policy/scale/usage | `read:license:app` | ✅（返回 project/wiki/desk/product 等 license 清单） |
| O-A12 | `POST /openapi/v3alpha/onesql/query` | ONESQL 查询 | 周期过滤的主力（`now(-90d)` 等时间函数、`v$cursor` 分页）；manifest 需声明 `read:project:issue`；**仅查 issue 表**（`from project` 等报 NotFound.WorkItemType） | `read:project:issue` | ✅（多团队查询返回正确） |
| O-A13 | `GET /openapi/v2/account/teams` | 组织团队列表 | — | `read:account:teams` | ✅（57 个团队） |
| O-A14 | `GET /openapi/v2/project/searchIssueFields` | 字段元数据 | 字段类型清单（无 code/commit 类型——代码关联不是工作项字段） | `read:project:issueField` | ✅（500 字段，类型清单确认） |

## B. 内部接口（CapabilityDetector 兜底，锁定 v7.22.x）

**M2 T2 结论（2026-08-20 实测）**：内部接口（页面 API）**无法从应用后端调用**——已实测 App token、用户委托 token（oauth type 需含 user）、ONES_HOSTED_TOKEN 三种鉴权方式调用 `/project/api/project/team/{team}/items/graphql`，全部返回 `401 AuthFailure.InvalidToken`。内部接口使用独立的 cookie/session 鉴权体系，与 OpenAPI OAuth token 不互通。

**影响**：B 节接口仅可作为「浏览器端证据采集」参考，不能作为应用运行时数据源。D5（代码集成）的运行时数据采集不可行——按健康度标准 §7 降级处理（详见 E 节 R1）。

| 编号 | 端点 | 用途 | 验证证据 |
| --- | --- | --- | --- |
| I-1 | `POST /project/api/project/team/{team}/items/graphql?t=Task` | **工作项级代码关联**（D5 核心证据）：`task(key)` 返回 `devopsCommitCount`、`devopsPullRequestsCount`、`devopsTasksCommits{author,branch,hash,message,repo,scm,timestamp,url}`、`devopsPullRequests{title,state,author,fromBranch,toBranch,repo,scmType,updateTime,createTime}`、`devopsPipelineRun{status,duration,startTime,finishTime,pipelineUUID,repo,branch}`、`devopsBranches` | GCSX-7982 实测返回 5 提交 + 1 MR，字段完整 |
| I-2 | `POST /project/api/project/team/{team}/items/graphql?t=repo-data-key` | 团队级 devops 数据：`devopsScmRepos`、`devopsCommits`、`devopsPullRequests`、`devopsPipelines`；支持 `where: { timestamp_gt: "..." }` 时间过滤；schema 支持 `automationRules/automationLogs` 等全部业务对象 | 跨团队实测（VAVx7WoU 7 commits / 3 PRs；无数据团队返回空数组） |
| I-3 | graphql `automationRules` / `automationLogs` | 流程自动化规则与触发记录（D8） | schema 已确认存在，数据未逐项验证 |
| I-4 | `GET /project/api/ones-project/team/{team}/copilot/agent/conversations` | AI 会话记录（D11） | 页面加载实测存在 |
| I-5 | `GET /project/api/project/organization/{org}/bff/licenses` | 组织 license 列表（无需管理员，购买判定兜底） | 页面加载实测 200 |
| I-6 | `GET /project/api/project/team/{team}/devops/scm/connectors/list` | 代码连接器（GitHub/GitLab/私有GitLab/SVN/Bitbucket） | 实测返回完整连接器清单 |
| I-7 | `GET /project/api/project/organization/{org}/teams` | 组织团队列表（含 member_count） | 实测返回 57 个团队 |
| I-8 | `GET /project/api/ones-project/team/{team}/issue/{uuid}/detail_form`、`form_tab_count`、`task/{uuid}/messages` | 工作项表单结构与动态（tab 组件：related_plan/related_task/estimated_hours/test_situation/field048 关联 Wiki） | 实测结构完整 |

### 关键原始契约（I-1，v7.22.1）

```graphql
query Task($key: Key) {
  task(key: $key) {
    key uuid name number
    codeCommits codeCommitsCount devopsCommitCount devopsPullRequestsCount
    devopsTasksCommits(orderBy: {timestamp: DESC}) {
      author branch hash message repo scm timestamp url uuid
      devopsPipelineRun { branch duration finishTime log number pipelineUUID repo startTime status triggerBy triggerType uuid devopsPipeline { name } }
    }
    devopsPullRequests(orderBy: {updateTime: DESC}) {
      key uuid number title state author fromBranch toBranch url reviewers repo scmType updateTime createTime updateUser
    }
    devopsBranchesCount
    devopsBranches(orderBy: {createTime: DESC}) { uuid owner { name } name url createTime repo scmType }
  }
}
# variables: { "key": "task-<uuid>" }
```

## C. appSettingPages 契约（工作台入口）

- manifest：`app.extensions.appSettingPages[]`，`maxItems: 1`，元素 `{ key: string(1-64), funcs: { customEntries: string } }`（路径 `/` 开头，≤ 256 字符）。
- 请求：POST `customEntries`，body `{ user_uuid, language, timezone }`（必填，无额外属性）。
- 响应：`{ entries: [{ title: string(1-128), page_url: string(相对路径, ^/) }] }`，entries ≤ 10。
- schema 来源：`.ones/ones-app-specs/schemas/extensions/app-setting-pages-*.json`。

## D. 其他实测事实

- 实例版本 v7.22.1（页面右下角「当前版本」）。
- 团队切换：修改 `localStorage.teamUUID/teamName` 后 reload 生效（浏览器操作技巧，非接口）。
- 机器人证据：消息接口 `from: "BOT"`、`subject_name: "系统"`；工作项创建者可见「流程自动化」。
- 工作项「代码关联」模块仅出现在相关项目/类型（GCSX 有、ZNZZ12 无）——代码关联 tab 的出现与项目配置相关，判定「已配置」应以团队级 `devopsScmRepos` 为准。
- `devopsCommits`（团队级）与 `devopsTasksCommits`（工作项关联）是两个口径：前者是仓库推送的全部提交，后者是**关联到工作项**的提交。D5 活跃判定使用后者（见健康度标准 D5）。
- 全局导航确认的产品面（v7.22.1）：知识库/项目/测试/工单/产品/项目集/资源/效能/流水线集成/任务协作/审批/版本管理/应用中心/配置中心；Assistant 未配置 AI 模型时显示占位提示。

## E. 缺口与待验证清单

**M2 已关闭项**：T2（内部接口鉴权——结论不可行）、T5（OpenAPI 实测——A 节 ✅ 项）、T11（`read:project:sprint` scope——可用）、T1（机器人标识——changelog 中 author.name 为 `{{system_bot}}`）。

| 编号 | 内容 | 影响 | 计划 |
| --- | --- | --- | --- |
| G1 | OpenAPI 无代码集成/SCM/pipeline 端点（spec 确认 0 命中）+ T2 内部接口不可达 | **D5 运行时探测不可行** | 见 R1 决策 |
| G2 | 测试执行数据（测试计划/用例执行记录）无 OpenAPI 端点 | D4 活跃判定 | M4 探测（预期同样受 T2 限制） |
| G3 | 项目集/Performance 数据源未确认 | D7 | M4 探测 |
| G4 | Desk 工单数据源未确认 | D9 | M4 探测 |
| T3 | Wiki 页面编辑时间明细（活跃判定） | D3 | M3 |
| T4 | 测试执行行为数据源 | D4 | M4 |
| T6 | 资源/排期视图使用数据 | D6 闭环 | M4 |
| T7 | 项目集对象与效能报表数据 | D7 | M4 |
| T8 | SSO 登录/目录同步/IM 通知行为数据 | D10 | M4 |
| T9 | Desk 工单生命周期数据 | D9 | M4 |
| T10 | changelog 10000 条截断的实测复现 | 韧性测试 | M5 |
| T12 | object_link_count 字段在代码集成团队的表现（VAVx7WoU 团队无此字段，需在有代码关联的工作项类型上验证） | D5 弱信号 | M3 |

### R2 决策记录：前端↔后端通道的用户身份验证（M6）

M6 实测（2026-08-21）：`ONES.fetchApp()` 经 relay（`/platform/app/relay/dispatch/{app}/...`）转发到应用后端时，**不携带任何可信用户身份**——仅有 `x-ones-baseurl`、`x-forwarded-*` 等代理头，无 Authorization/JWT/用户标识。Web SDK 的 `getUserInfo()` 仅在浏览器端可用，其结果传给后端即客户端可伪造数据。

**影响**：README「后端从已验证的安装及用户上下文取得身份」在 Hosted App 前后端通道上无平台级支持。

**分层控制（已实现）**：
1. **白名单**：`permission_whitelist` 实体（团队级，admin/member 角色）；所有 `/api/*` 报告端点经 `WhitelistGuard`（缺身份参数 401、非白名单 403、跨团队隔离）。
2. **审计**：白名单变更、任务创建、叙事编辑、导出全量审计（含 actor 标识）。
3. **数据面最小权限**：后端 OpenAPI 调用受 OAuth scope 限制（13 个只读 scope）；App token 无法写业务数据。
4. **已知残余风险（记录）**：知道白名单成员 user_uuid 的恶意客户端可冒充该成员调用 API。真实 user uuid 需 ONES 成员可见性才能获取；生产部署建议结合网络层控制（私有环境访问限制）。此为平台能力边界，ONES 后续版本若提供 fetchApp 身份头可无缝升级（guard 预留 request.whitelistUser 注入点）。

T2 + G1 联合结论：代码关联数据（提交/MR/流水线）在应用运行时不可获取。D5 维度调整为：

1. **购买判定**：license 清单（O-A11 ✅）判断「代码集成」是否已购。
2. **已购 + 无法核验**：无法确认活跃度的部分按健康度标准 §7 判 `无法核验`（不是未配置——配置证据需要 devops 数据）。
3. **弱信号补充（T12 待验证）**：若 `object_link_count` 字段在有代码关联的工作项类型上可查（ONESQL/字段元数据），可作为「已关联业务对象」的弱证据，将 D5 从 `无法核验` 提升为「有配置迹象」。
4. README 规格中「内部接口漂移返回无法核验」的安全降级在此场景下成为常态——这符合规格设计（探测目标，不取消安全降级）。

### R1 决策记录：D5 代码集成的运行时采集方案

T2 + G1 联合结论：代码关联数据（提交/MR/流水线）在应用运行时不可获取。D5 维度调整为：

1. **购买判定**：license 清单（O-A11 ✅）判断「代码集成」是否已购。
2. **已购 + 无法核验**：无法确认活跃度的部分按健康度标准 §7 判 `无法核验`（不是未配置——配置证据需要 devops 数据）。
3. **弱信号补充（T12 待验证）**：若 `object_link_count` 字段在有代码关联的工作项类型上可查（ONESQL/字段元数据），可作为「已关联业务对象」的弱证据，将 D5 从 `无法核验` 提升为「有配置迹象」。
4. README 规格中「内部接口漂移返回无法核验」的安全降级在此场景下成为常态——这符合规格设计（探测目标，不取消安全降级）。

## F. 验收对照

- README 验收步骤 1（证据矩阵）：本文件 + 健康度标准；OpenAPI 契约 + App Identity 实测（M2 ✅）+ 内部接口浏览器契约（M1 ✅）+ 后端可达性结论（T2 ✅ 不可达）。
- README 验收步骤 6（两类样本团队）：已确认 VAVx7WoU（活跃）与 CXBRmzxd（已配置未活跃）。

## G. M2 运行时实测补充（2026-08-20）

- **应用安装链路**：`ones dev --install` → 应用中心显示「已启用/开发中」；install 回调携带 `installation_id/shared_secret/ones_base_url`（base64 密钥）。
- **entity storage**：key 必须匹配 `/^[_a-z0-9]{1,64}$/`（安装 ID 需规范化）；查询返回 `{page_info, data: [{key, value}]}` 结构（value 才是实体数据）。
- **appSettingPages**：extension key 必须为 `entries`（`report_entries` 报 InvalidParameter）；入口显示在**组织级应用详情页**的 tab（「配置中心 > 应用管理 > 已获取应用 > customer-value-health」）；customEntries 页面经 relay 分发加载。
- **前端页面**：React 17 + ReactDOM.render（JSX 元素挂载，不能直接调用组件函数——Invalid hook call）；ONES 沙箱将 HTML 复制为 blob iframe 并剥离 script 由宿主注入执行。
- **用户委托 token**：oauth type 需含 `user`；为用户生成 token 需该用户已在组织中（`not allow generating token for the user` 错误表示无权限）。
