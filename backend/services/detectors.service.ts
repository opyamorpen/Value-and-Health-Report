import { Injectable, Logger } from '@nestjs/common'
import { OpenApiClientService } from './openapi-client.service'
import { RULE_VERSION } from '../types'

/**
 * CapabilityDetector 探测器框架（docs/health-standard.md）。
 * 每个探测器声明：版本、依赖数据源、响应校验、降级规则。
 * 接口失败/漂移/权限不足 → 无法核验；绝不静默推断。
 */

export type Maturity =
  | '未配置'
  | '已配置未活跃'
  | '活跃使用'
  | '形成闭环'
  | '未购买'
  | '不适用'
  | '无法核验'

export type DetectorFailure = 'network' | 'auth' | 'scope' | 'permission' | 'schema-drift' | 'version'

export type DetectorResult = {
  dimension: string
  maturity: Maturity
  /** 旁路状态（未购买/不适用/无法核验）时 maturity 已含；此处补充原因 */
  reason?: string
  failure?: DetectorFailure
  coverage: number
  confidence: 'high' | 'medium' | 'low'
  lastCollectedAt: number
  evidence: Array<{ source: string; detail: string }>
  suggestion?: string
}

export type DetectorContext = {
  teamUuid: string
  periodStart: number
  periodEnd: number
}

export interface CapabilityDetector {
  readonly dimension: string
  /** 探测器实现的锁定版本（v7.22.x） */
  readonly detectorVersion: string
  /** 依赖的 OpenAPI 端点（证据引用） */
  readonly sources: string[]
  detect(ctx: DetectorContext): Promise<DetectorResult>
}

/** 探测失败 → 无法核验（统一降级） */
const unverifiable = (
  dimension: string,
  failure: DetectorFailure,
  error: unknown,
): DetectorResult => ({
  dimension,
  maturity: '无法核验',
  failure,
  reason: String((error as Error)?.message ?? error).slice(0, 150),
  coverage: 0,
  confidence: 'low',
  lastCollectedAt: Date.now(),
  evidence: [],
})

/** 从 OpenAPI 错误分类失败类型 */
const classifyFailure = (error: unknown): DetectorFailure => {
  const status = (error as { status?: number })?.status
  if (status === 401) return 'auth'
  if (status === 403) return 'scope'
  if (status === 404) return 'schema-drift'
  if (status && status >= 500) return 'network'
  const message = String((error as Error)?.message ?? '')
  if (message.includes('FAIL') || message.includes('InvalidField')) return 'schema-drift'
  return 'network'
}

/** license 清单中的模块 appID 映射（维度 → appID） */
const MODULE_APP_IDS: Record<string, string> = {
  D4_Test: 'testcase',
  D9_Desk: 'desk',
  D3_Wiki: 'wiki',
  D7_Performance: 'performance',
  D11_Assistant: 'copilot',
  D12_Other: 'xmind',
}

type LicenseList = Array<{ appID: string; scale?: number; usage?: number }>

@Injectable()
export class DetectorsService {
  private readonly logger = new Logger(DetectorsService.name)
  private licenseCache: { data: LicenseList; at: number } | undefined

  constructor(private readonly openApi: OpenApiClientService) {}

  /** 全部维度探测入口 */
  async detectAll(ctx: DetectorContext): Promise<DetectorResult[]> {
    const detectors = this.buildDetectors()
    const results: DetectorResult[] = []
    for (const detector of detectors) {
      try {
        results.push(await detector.detect(ctx))
      } catch (error) {
        this.logger.warn(`detector ${detector.dimension} failed: ${String((error as Error).message).slice(0, 100)}`)
        results.push(unverifiable(detector.dimension, classifyFailure(error), error))
      }
    }
    return results
  }

  private buildDetectors(): CapabilityDetector[] {
    return [
      this.projectWorkflowDetector(),
      this.sprintDetector(),
      this.wikiDetector(),
      this.testcaseDetector(),
      this.codeIntegrationDetector(),
      this.worklogDetector(),
      this.programDetector(),
      this.automationDetector(),
      this.deskDetector(),
      this.accountDetector(),
      this.assistantDetector(),
      this.otherAppsDetector(),
    ]
  }

  /** 组织 license（购买判定，缓存 5 分钟） */
  private async getLicenses(): Promise<LicenseList> {
    if (this.licenseCache && Date.now() - this.licenseCache.at < 5 * 60_000) {
      return this.licenseCache.data
    }
    const resp = await this.openApi.get<{ data?: LicenseList }>('license/apps')
    const list = resp?.data ?? []
    this.licenseCache = { data: list, at: Date.now() }
    return list
  }

  private async isPurchased(moduleKey: string): Promise<boolean> {
    const licenses = await this.getLicenses()
    const appId = MODULE_APP_IDS[moduleKey]
    return licenses.some(l => l.appID === appId)
  }

  // D1 项目与工作项流程
  private projectWorkflowDetector(): CapabilityDetector {
    return {
      dimension: 'D1 项目与工作项流程',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A1 projects', 'O-A4 changelog'],
      detect: async ctx => {
        const projects = await this.openApi.get<{ data?: { list?: Array<{ id?: string; isArchive?: boolean }> } }>(
          'project/projects',
          { teamID: ctx.teamUuid, limit: 100 },
        )
        const activeProjects = (projects?.data?.list ?? []).filter(p => !p.isArchive).length
        if (activeProjects === 0) {
          return {
            dimension: 'D1 项目与工作项流程',
            maturity: '未配置',
            coverage: 1,
            confidence: 'high',
            lastCollectedAt: Date.now(),
            evidence: [{ source: 'O-A1', detail: `团队项目数（未归档）= 0` }],
            suggestion: '创建第一个项目以开始工作项流程管理',
          }
        }
        // 活跃行为：周期内工作项变更（ONESQL 近似）
        const sql = `select count(uid(uuid)) as total from issue where uid(field013) > ${ctx.periodStart} and uid(field013) < ${ctx.periodEnd}`
        const activity = await this.openApi.post<Record<string, unknown>>(
          '../v3alpha/onesql/query',
          { query: sql },
          { teamID: ctx.teamUuid },
        )
        const created = Number((activity?.data as { data?: Array<{ item?: { total?: number } }> })?.data?.[0]?.item?.total ?? 0)
        const maturity: Maturity = created >= 10 ? '活跃使用' : activeProjects > 0 ? '已配置未活跃' : '未配置'
        return {
          dimension: 'D1 项目与工作项流程',
          maturity,
          coverage: 1,
          confidence: 'high',
          lastCollectedAt: Date.now(),
          evidence: [
            { source: 'O-A1', detail: `${activeProjects} 个未归档项目` },
            { source: 'O-A12', detail: `周期内新建工作项 ${created} 个` },
          ],
          suggestion: maturity === '活跃使用' ? '工作项全生命周期（含首次完成与重开管理）可进一步形成闭环' : '在项目内创建并流转工作项',
        }
      },
    }
  }

  // D2 Sprint
  private sprintDetector(): CapabilityDetector {
    return {
      dimension: 'D2 Sprint 与敏捷执行',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A1 projects', 'O-A2 sprints'],
      detect: async ctx => {
        const projects = await this.openApi.get<{ data?: { list?: Array<{ id?: string }> } }>('project/projects', {
          teamID: ctx.teamUuid,
          limit: 100,
        })
        let sprintCount = 0
        for (const project of (projects?.data?.list ?? []).slice(0, 50)) {
          const sprints = await this.openApi.get<{ data?: { list?: unknown[] } }>(
            `project/projects/${project.id}/sprints`,
            { teamID: ctx.teamUuid },
          )
          sprintCount += (sprints?.data?.list ?? []).length
        }
        const maturity: Maturity = sprintCount === 0 ? '未配置' : '活跃使用'
        return {
          dimension: 'D2 Sprint 与敏捷执行',
          maturity,
          coverage: 1,
          confidence: 'high',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'O-A2', detail: `共 ${sprintCount} 个 Sprint` }],
          suggestion: sprintCount === 0 ? '在敏捷项目中创建迭代' : '推动迭代进入终态并跟踪按期完成率',
        }
      },
    }
  }

  // D3 Wiki（license 判定 + 活跃）
  private wikiDetector(): CapabilityDetector {
    return {
      dimension: 'D3 Wiki 与知识协作',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A11 license', 'O-A7 wiki spaces'],
      detect: async ctx => {
        if (!(await this.isPurchased('D3_Wiki'))) {
          return this.notPurchasedResult('D3 Wiki 与知识协作', 'wiki')
        }
        const spaces = await this.openApi.get<{ data?: { list?: unknown[] } }>('wiki/spaces', { teamID: ctx.teamUuid })
        const count = (spaces?.data?.list ?? []).length
        return {
          dimension: 'D3 Wiki 与知识协作',
          maturity: count === 0 ? '未配置' : '活跃使用',
          coverage: 1,
          confidence: 'medium',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'O-A7', detail: `${count} 个知识库空间` }],
          suggestion: count === 0 ? '创建知识库空间沉淀项目文档' : '将工作项与 Wiki 页面关联形成知识沉淀链',
        }
      },
    }
  }

  // D4 Test（license + 用例库）
  private testcaseDetector(): CapabilityDetector {
    return {
      dimension: 'D4 Test 与质量闭环',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A11 license', 'O-A9 testcase libraries'],
      detect: async ctx => {
        if (!(await this.isPurchased('D4_Test'))) {
          return this.notPurchasedResult('D4 Test 与质量闭环', 'testcase')
        }
        const libs = await this.openApi.get<{ data?: { list?: unknown[] } }>('testcase/libraries', { teamID: ctx.teamUuid, limit: 100 })
        const count = (libs?.data?.list ?? []).length
        return {
          dimension: 'D4 Test 与质量闭环',
          maturity: count === 0 ? '未配置' : '已配置未活跃',
          coverage: 1,
          confidence: 'medium',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'O-A9', detail: `${count} 个测试用例库` }],
          suggestion: count === 0 ? '创建测试用例库并编写用例' : '执行测试计划，将缺陷与用例关联形成质量闭环（执行明细暂无法核验）',
        }
      },
    }
  }

  // D5 代码集成（R1 决策：数据源不可达 → 已购无法核验）
  private codeIntegrationDetector(): CapabilityDetector {
    return {
      dimension: 'D5 代码仓与流水线集成',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A11 license', 'R1 决策（内部接口不可达）'],
      detect: async () => {
        // 代码集成的 license 通常绑定 project 模块（无独立 appID）——按 project 购买判断
        const purchased = await this.isProjectModulePurchased()
        if (!purchased) {
          return this.notPurchasedResult('D5 代码仓与流水线集成', '代码集成')
        }
        return {
          dimension: 'D5 代码仓与流水线集成',
          maturity: '无法核验',
          reason: '代码关联数据（提交/MR/流水线）无开放接口且内部接口不可从应用后端访问（T2 实测结论）',
          failure: 'version',
          coverage: 0,
          confidence: 'low',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'evidence-matrix R1', detail: '运行时不可达；无法区分未配置/活跃/闭环' }],
          suggestion: '请在 ONES 代码集成配置页人工确认仓库关联状态，作为人工补证录入',
        }
      },
    }
  }

  private async isProjectModulePurchased(): Promise<boolean> {
    const licenses = await this.getLicenses()
    return licenses.some(l => l.appID === 'project')
  }

  // D6 工时
  private worklogDetector(): CapabilityDetector {
    return {
      dimension: 'D6 工时与资源',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A5 worklog estimated'],
      detect: async ctx => {
        const start = new Date(ctx.periodStart).toISOString().slice(0, 10)
        const end = new Date(ctx.periodEnd).toISOString().slice(0, 10)
        const worklogs = await this.openApi.get<{ data?: { list?: unknown[] } }>('project/workLog/timesEstimated', {
          teamID: ctx.teamUuid,
          startDate: start,
          endDate: end,
          limit: 100,
        })
        const count = (worklogs?.data?.list ?? []).length
        return {
          dimension: 'D6 工时与资源',
          maturity: count === 0 ? '未配置' : '活跃使用',
          coverage: 1,
          confidence: 'medium',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'O-A5', detail: `周期内 ${count} 条工时预估记录` }],
          suggestion: count === 0 ? '为工作项填写预估工时并启用资源视图' : '预估与实际登记对照，用于排期与资源管理',
        }
      },
    }
  }

  // D7 项目集/Performance（数据源不可达 → 无法核验）
  private programDetector(): CapabilityDetector {
    return {
      dimension: 'D7 项目集与 Performance',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['G3 缺口'],
      detect: async () => {
        const purchased = await this.isPurchased('D7_Performance')
        if (!purchased) {
          return this.notPurchasedResult('D7 项目集与 Performance', 'performance')
        }
        return {
          dimension: 'D7 项目集与 Performance',
          maturity: '无法核验',
          reason: '项目集与效能报表数据无开放接口（G3）',
          coverage: 0,
          confidence: 'low',
          lastCollectedAt: Date.now(),
          evidence: [],
          suggestion: '人工确认项目集使用情况',
        }
      },
    }
  }

  // D8 流程自动化（数据源不可达 → 无法核验）
  private automationDetector(): CapabilityDetector {
    return {
      dimension: 'D8 流程自动化',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['G1 缺口（graphql automationRules 不可达）'],
      detect: async () => ({
        dimension: 'D8 流程自动化',
        maturity: '无法核验',
        reason: '自动化规则与触发记录无开放接口（内部 graphql 不可达）',
        failure: 'version',
        coverage: 0,
        confidence: 'low',
        lastCollectedAt: Date.now(),
        evidence: [],
        suggestion: '人工确认自动化规则配置与触发情况',
      }),
    }
  }

  // D9 Desk
  private deskDetector(): CapabilityDetector {
    return {
      dimension: 'D9 Desk 服务管理',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A11 license', 'G4 缺口'],
      detect: async () => {
        if (!(await this.isPurchased('D9_Desk'))) {
          return this.notPurchasedResult('D9 Desk 服务管理', 'desk')
        }
        return {
          dimension: 'D9 Desk 服务管理',
          maturity: '无法核验',
          reason: '工单生命周期数据无开放接口（G4）',
          coverage: 0,
          confidence: 'low',
          lastCollectedAt: Date.now(),
          evidence: [],
          suggestion: '人工确认工单处理与 SLA 情况',
        }
      },
    }
  }

  // D10 Account/SSO（部分可探测：第三方绑定）
  private accountDetector(): CapabilityDetector {
    return {
      dimension: 'D10 Account 与 SSO 集成',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A10 thirdparty binding'],
      detect: async ctx => {
        const bindings = await this.openApi.get<{ data?: { list?: unknown[] } }>(
          'account/users/thirdparty/binding/batch',
          { teamID: ctx.teamUuid, limit: 100 },
        )
        const count = (bindings?.data?.list ?? []).length
        return {
          dimension: 'D10 Account 与 SSO 集成',
          maturity: count === 0 ? '未配置' : '活跃使用',
          coverage: 1,
          confidence: 'medium',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'O-A10', detail: `${count} 条第三方账号绑定` }],
          suggestion: count === 0 ? '配置 SSO 或目录同步' : '保持目录同步与 IM 通知联动',
        }
      },
    }
  }

  // D11 Assistant（数据源不可达 → 无法核验）
  private assistantDetector(): CapabilityDetector {
    return {
      dimension: 'D11 Assistant 与 AI',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['G1 缺口（copilot conversations 不可达）'],
      detect: async () => ({
        dimension: 'D11 Assistant 与 AI',
        maturity: '无法核验',
        reason: 'AI 会话数据无开放接口（内部接口不可达）',
        failure: 'version',
        coverage: 0,
        confidence: 'low',
        lastCollectedAt: Date.now(),
        evidence: [],
        suggestion: '人工确认 AI 模型配置与使用情况',
      }),
    }
  }

  // D12 其他已购应用
  private otherAppsDetector(): CapabilityDetector {
    return {
      dimension: 'D12 其他已购应用',
      detectorVersion: 'v7.22-detector-v0.1',
      sources: ['O-A11 license'],
      detect: async () => {
        const licenses = await this.getLicenses()
        return {
          dimension: 'D12 其他已购应用',
          maturity: '不适用',
          reason: '本维度仅报告购买与安装状态（进入增购机会分析），不做成熟度判定',
          coverage: 1,
          confidence: 'high',
          lastCollectedAt: Date.now(),
          evidence: [{ source: 'O-A11', detail: `已购模块：${licenses.map(l => l.appID).join('、') || '无'}` }],
        }
      },
    }
  }

  private notPurchasedResult(dimension: string, moduleName: string): DetectorResult {
    return {
      dimension,
      maturity: '未购买',
      reason: `模块「${moduleName}」不在组织 license 清单中，不计入健康度`,
      coverage: 1,
      confidence: 'high',
      lastCollectedAt: Date.now(),
      evidence: [{ source: 'O-A11', detail: 'license 清单未包含该模块' }],
      suggestion: '该模块进入增购机会建议分析',
    }
  }
}

/** 增购机会：未购模块 × 现有业务证据 */
export type Opportunity = {
  moduleKey: string
  moduleName: string
  reason: string
  evidence: string
}

export function buildOpportunities(results: DetectorResult[]): Opportunity[] {
  const notPurchased = results.filter(r => r.maturity === '未购买')
  const activeCore = results.some(r => r.dimension.startsWith('D1') && r.maturity === '活跃使用')
  const opportunities: Opportunity[] = []
  for (const item of notPurchased) {
    const moduleName = item.dimension.replace(/^D\d+[_\s]+/u, '')
    let reason = '组织尚未购买该模块'
    if (activeCore) {
      reason = '核心项目管理已活跃使用，该模块可作为能力扩展'
    }
    opportunities.push({
      moduleKey: item.dimension,
      moduleName,
      reason,
      evidence: item.evidence[0]?.detail ?? 'license 清单未包含',
    })
  }
  return opportunities
}

export const DETECTOR_RULE_VERSION = RULE_VERSION
