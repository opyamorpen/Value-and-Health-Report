/**
 * 核心领域类型（对应 README「应用接口与核心类型」）。
 * 所有结果统一携带 status/source/collectedAt/coverage/confidence/ruleVersion。
 * v0.2（docs/value-standard.md）：统一环比结构 + 四轴九维度 + 价值亮点。
 */

export const RULE_VERSION = 'value-standard-v0.2'

/** 周期定义：当前周期与对比周期（毫秒时间戳） */
export type Period = {
  start: number
  end: number
  compareStart: number
  compareEnd: number
}

export type MetricStatus = 'ok' | 'unknown' | 'failed'

/** 指标通用信封 */
export type MetricEnvelope = {
  status: MetricStatus
  source: string
  collectedAt: number
  coverage: number
  confidence: 'high' | 'medium' | 'low'
  ruleVersion: string
}

/** 环比结构（value-standard §2.1）：direction 决定数值变化的改善解读 */
export type Compared = {
  current: number | null
  previous: number | null
  delta: number | null
  /** 数值类：相对变化 %；previous=0 且 current>0 时为 null（用 trendLabel=新增 表达） */
  deltaPercent: number | null
  /** 比率类：百分点差（current/previous 以 0~1 存储时 ×100） */
  deltaPP: number | null
  trendLabel: '显著提升' | '略有提升' | '基本持平' | '略有下降' | '显著下降' | '新增' | '未知'
  direction: 'up' | 'down' | 'neutral'
  isImprovement: boolean | null
  sampleSize: number
}

export const compareValues = (
  direction: Compared['direction'],
  current: number | null,
  previous: number | null,
  kind: 'count' | 'ratio',
  sampleSize: number,
  Q = 5,
): Compared => {
  const unknown: Compared = {
    current,
    previous,
    delta: null,
    deltaPercent: null,
    deltaPP: null,
    trendLabel: '未知',
    direction,
    isImprovement: null,
    sampleSize,
  }
  if (current == null || previous == null || sampleSize < Q) return unknown
  const delta = current - previous
  const deltaPP = kind === 'ratio' ? Math.round(delta * 1000) / 10 : null
  if (previous === 0 && current > 0) {
    return { ...unknown, delta, deltaPercent: null, deltaPP, trendLabel: '新增', isImprovement: direction !== 'down' }
  }
  if (previous === 0 && current === 0) {
    return { ...unknown, delta, deltaPercent: 0, deltaPP, trendLabel: '基本持平', isImprovement: null }
  }
  const deltaPercent = Math.round((delta / Math.abs(previous)) * 1000) / 10
  const absPct = Math.abs(deltaPercent)
  const absPP = Math.abs(deltaPP ?? 0)
  const absVal = kind === 'ratio' ? absPP : absPct
  const sig = kind === 'ratio' ? absVal >= 5 : absVal >= 10
  const slight = kind === 'ratio' ? absVal >= 2 : absVal >= 5
  const trendLabel: Compared['trendLabel'] = delta > 0
    ? (sig ? '显著提升' : slight ? '略有提升' : '基本持平')
    : delta < 0
      ? (sig ? '显著下降' : slight ? '略有下降' : '基本持平')
      : '基本持平'
  const isImprovement =
    direction === 'neutral' ? null : (delta > 0) === (direction === 'up') ? delta !== 0 || null : false
  return { ...unknown, delta, deltaPercent, deltaPP, trendLabel, isImprovement, sampleSize }
}

/** 统计范围背景行（value-standard §3.x：项目降级为背景，不进亮点池） */
export type ScopeMetrics = MetricEnvelope & {
  activeProjects: Compared
  newProjects: number
}

/** A1 需求与价值交付（typeSplit=false 时按全类型口径并标注） */
export type RequirementMetrics = MetricEnvelope & {
  typeSplit: boolean
  /** 类型映射覆盖率（已分类 / 已采集） */
  mappingCoverage: number | null
  created: Compared
  delivered: Compared
  cycleP50Hours: Compared
  onTimeRate: Compared
  /** 交付的需求中关联过迭代的占比（sprintUuid 非空口径） */
  sprintLinkedRate: Compared
}

/** A2 缺陷与质量 */
export type DefectMetrics = MetricEnvelope & {
  typeSplit: boolean
  found: Compared
  fixed: Compared
  /** 报告生成时点仍非终态（周期内创建） */
  open: number
  fixCycleP50Hours: Compared
  reopenRate: Compared
}

/** A3 敏捷迭代执行 */
export type SprintExecutionMetrics = MetricEnvelope & {
  finished: Compared
  onTimeRate: Compared
  /** 完成迭代承载的工作项数（总量口径） */
  deliveredItems: Compared
  /** 有终态 Sprint 的不同自然周数 */
  cadenceWeeks: number
  finishTrend: Array<{ week: string; count: number }>
}

/** B1 交付效率 + B2 计划兑现 */
export type DeliveryEfficiencyMetrics = MetricEnvelope & {
  cycleP50Hours: Compared
  cycleP75Hours: Compared
  weeklyThroughput: Compared
  onTimeRate: Compared
  reopenRate: Compared
  throughputTrend: Array<{ week: string; created: number; completed: number }>
}

/** C1 协作参与 */
export type CollaborationMetrics = MetricEnvelope & {
  participants: Compared
  manualActions: Compared
  /** 有行为的不同自然周数 */
  activeWeeks: number
  weeklyTrend: Array<{ week: string; actions: number; participants: number }>
}

/** C2 管理规范度 */
export type DisciplineMetrics = MetricEnvelope & {
  assigneeFillRate: Compared
  dueDateFillRate: Compared
  sprintDateDisciplineRate: Compared
  /** 有起止日期 Sprint 时长中位数（天）；neutral，不进亮点池 */
  sprintLengthMedianDays: number | null
}

/** C3 工时实践 */
export type WorklogPracticeMetrics = MetricEnvelope & {
  estimateCoverage: Compared
  spentCoverage: Compared
  /** |实际-预估|/预估 中位数（0~1）；仅两者齐备样本，样本<Q 为 null */
  estimateAccuracyMedian: number | null
  pairedSampleSize: number
}

/** D1 知识沉淀 */
export type KnowledgeMetrics = MetricEnvelope & {
  wikiLinkedCount: Compared
  wikiLinkedRate: Compared
  /** 参考值，不环比 */
  wikiSpaces: number | null
}

/** 值报告 v0.2：四轴九维度 + 价值亮点（docs/value-standard.md） */
export type ValueReport = {
  period: Period
  scope: ScopeMetrics
  requirement: RequirementMetrics
  defect: DefectMetrics
  sprintExecution: SprintExecutionMetrics
  deliveryEfficiency: DeliveryEfficiencyMetrics
  collaboration: CollaborationMetrics
  discipline: DisciplineMetrics
  worklogPractice: WorklogPracticeMetrics
  knowledge: KnowledgeMetrics
  /** 价值亮点（Top 3~5 显著改善 + 新增实践；无显著改善时回退最大绝对成果） */
  highlights: Array<{ text: string; metric: string; kind: 'improvement' | 'new-practice' | 'achievement' }>
  /** 需关注（显著退步，中性措辞；最多 2 条） */
  concerns: Array<{ text: string; metric: string }>
}

export type HealthMatrix = {
  results: Array<{
    dimension: string
    maturity: string
    reason?: string
    coverage: number
    confidence: string
    lastCollectedAt: number
    evidence: Array<{ source: string; detail: string }>
    suggestion?: string
  }>
  opportunities: Array<{
    moduleKey: string
    moduleName: string
    reason: string
    evidence: string
  }>
}

/** 快照：不可变指标 + 可编辑叙事 */
export type ReportSnapshot = {
  snapshotId: string
  jobId: string
  teamUuid: string
  period: Period
  ruleVersion: string
  valueReport: ValueReport
  healthMatrix: HealthMatrix
  collectedAt: number
}

export type EvidenceRef = {
  metric: string
  source: string
  query?: string
  collectedAt: number
  sampleSize?: number
}

/** 任务状态机 */
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed'

export type JobStage =
  | 'queued'
  | 'collecting_projects'
  | 'collecting_sprints'
  | 'collecting_issue_types'
  | 'collecting_issues'
  | 'collecting_changelog'
  | 'collecting_worklog'
  | 'computing_metrics'
  | 'saving_snapshot'
  | 'done'

export type ReportJob = {
  jobId: string
  teamUuid: string
  period: Period
  ruleVersion: string
  status: JobStatus
  stage: JobStage
  progress: number
  error: string
  snapshotKey: string
  requestedBy: string
  createdAt: number
  updatedAt: number
}

/** 审计动作枚举 */
export type AuditAction =
  | 'job_created'
  | 'job_finished'
  | 'narrative_edited'
  | 'export_generated'
  | 'report_deleted'
  | 'whitelist_updated'

export type AuditEntry = {
  logId: string
  teamUuid: string
  actorUuid: string
  action: AuditAction
  targetType: string
  targetId: string
  detail: Record<string, unknown>
  createdAt: number
}
