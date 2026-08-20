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

契约来源：`.ones/ones-app-specs/openapi-spec.yaml`（2026-08-13 官方包，SHA256 `f9b72c71…`）。**尚未用 App Identity 实测**（待 M2 安装后执行，见 T5）。

| 编号 | 端点 | 用途 | 关键约束 | scope |
| --- | --- | --- | --- | --- |
| O-A1 | `GET /openapi/v2/project/projects` | 项目列表 | `limit` 默认 50、上限 100（超出截断）；`cursor` 分页 | `read:project:project` |
| O-A2 | `GET /openapi/v2/project/projects/{projectID}/sprints` | Sprint 列表 | **不支持分页/过滤**；返回全部可见未删除 Sprint | `read:project:sprint` |
| O-A3 | `GET /openapi/v2/project/issues` | 工作项列表 | `limit` 上限 100；仅支持 `projectID+issueTypeID` 联合过滤，**无日期过滤**（周期统计靠 ONESQL/changelog） | `read:project:issue` |
| O-A4 | `POST /openapi/v2/project/issueFields/changeLog/query` | 变更日志 | 按 issue 分页（`cursor+limit`，limit 上限 1000）；`issue_uuids` 必填，单批 ≤ 1000；返回记录上限 **10000，超出时 `records_truncated=true`**；`create_time`/`update_time` 过滤的是 issue 字段而非 version 字段 | `read:project:issueField` |
| O-A5 | `GET /openapi/v2/project/workLog/timesEstimated` | 团队级预估工时 | `limit` 上限 100；支持 `startDate/endDate`（YYYY-MM-DD）、`userID`、`issueID` | `read:project:workLog-timeEstimated` |
| O-A6 | `GET /openapi/v2/project/issues/{issueID}/workLog/simple/timesSpent` | 工作项登记工时 | `limit` 上限 100 | `read:project:issue-timeSpent` |
| O-A7 | `GET /openapi/v2/wiki/spaces` | Wiki 空间 | 支持 `requestUserID`（OAuth bot 代指定用户） | `read:wiki:space` |
| O-A8 | `GET /openapi/v2/wiki/spaces/{spaceID}/pages`、`GET /openapi/v2/wiki/pages/{pageID}` | Wiki 页面 | — | `read:wiki:page` |
| O-A9 | `GET /openapi/v2/testcase/libraries` | 测试用例库 | `limit` 上限 100 | `read:testcase:library` |
| O-A10 | `GET /openapi/v2/account/users/search`、`/account/users/batch`、`/account/users/thirdparty/binding/batch` | 用户与第三方绑定 | `limit` 上限 100 | `read:account:user` |
| O-A11 | `GET /openapi/v2/license/apps` | 组织购买应用 | **需组织管理员**；返回 appID/policy/scale/usage | `read:license:app` |
| O-A12 | `POST /openapi/v3alpha/onesql/query` | ONESQL 查询 | 周期过滤的主力（`now(-90d)` 等时间函数、`v$cursor` 分页）；manifest 需声明 `read:project:issue` | `read:project:issue` |
| O-A13 | `GET /openapi/v2/account/teams` | 组织团队列表 | — | `read:account:teams` |

注：sprints 相关端点要求的 `read:project:sprint` 未出现在 spec 全局 scope 枚举中，但端点 security 已声明；M2 安装时以实测为准（见 T11）。

## B. 内部接口（CapabilityDetector 兜底，锁定 v7.22.x）

**重要**：内部接口均为登录态浏览器验证（cookie 会话）。**从应用后端调用的鉴权方式未验证**（见 T2，M2 关键风险项）。

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

| 编号 | 内容 | 影响 | 计划 |
| --- | --- | --- | --- |
| G1 | OpenAPI 无代码集成/SCM/pipeline 端点（spec 确认 0 命中） | D5 必须依赖内部接口 I-1/I-2 | T2 通过后实现探测器 |
| G2 | 测试执行数据（测试计划/用例执行记录）无 OpenAPI 端点 | D4 活跃判定 | M4 探测 |
| G3 | 项目集/Performance 数据源未确认 | D7 | M4 探测 |
| G4 | Desk 工单数据源未确认 | D9 | M4 探测 |
| **T2** | **内部接口从应用后端调用的鉴权方式**（App token / 用户委托 token / 其他）——当前仅浏览器 cookie 验证 | **I-1~I-8 全部依赖此结论，M2 最高优先级** | M2 安装应用后逐一实测 |
| T1 | OpenAPI 用户模型中机器人标识字段 | §8 机器人过滤 | M2 |
| T3 | Wiki 页面编辑时间明细（活跃判定） | D3 | M2 |
| T4 | 测试执行行为数据源 | D4 | M4 |
| T5 | OpenAPI 全部端点的 App Identity 实测（分页/限流/401/403 行为） | O-A1~A13 | M2 |
| T6 | 资源/排期视图使用数据 | D6 闭环 | M4 |
| T7 | 项目集对象与效能报表数据 | D7 | M4 |
| T8 | SSO 登录/目录同步/IM 通知行为数据 | D10 | M4 |
| T9 | Desk 工单生命周期数据 | D9 | M4 |
| T10 | changelog 10000 条截断的实测复现 | 韧性测试 | M5 |
| T11 | `read:project:sprint` scope 实际可用性 | O-A2 | M2 |

## F. 验收对照

- README 验收步骤 1（证据矩阵）：本文件 + 健康度标准，OpenAPI 契约来自官方 spec 包；OpenAPI 实测与内部接口鉴权验证（T2/T5）依赖 M2 应用安装后执行。
- README 验收步骤 6（两类样本团队）：已确认 VAVx7WoU（活跃）与 CXBRmzxd（已配置未活跃）。
