/**
 * 核心领域类型（对应 README「应用接口与核心类型」）。
 * 所有结果统一携带 status/source/collectedAt/coverage/confidence/ruleVersion。
 */

export const RULE_VERSION = 'health-standard-v0.1'

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

export type ProjectMetrics = MetricEnvelope & {
  newProjects: number
  activeProjects: number
  statusDistribution: Record<string, number>
}

export type SprintMetrics = MetricEnvelope & {
  created: number
  finished: number
  onTimeFinished: number
  /** 周期内终态 Sprint 的连续分布（ISO 周 → 完成数） */
  finishTrend: Array<{ week: string; count: number }>
}

export type IssueMetrics = MetricEnvelope & {
  created: number
  firstCompleted: number
  reopened: number
  /** 周吞吐量（按周） */
  throughputTrend: Array<{ week: string; created: number; completed: number }>
}

export type CycleTimeMetrics = MetricEnvelope & {
  /** 创建→首次完成（小时）；样本 < Q 时 status=unknown */
  p50Hours: number | null
  p75Hours: number | null
  sampleSize: number
}

export type CollaborationMetrics = MetricEnvelope & {
  manualFieldChanges: number
  comments: number
  worklogs: number
  participants: number
  weeklyTrend: Array<{ week: string; actions: number; participants: number }>
}

export type PlanFulfillmentMetrics = MetricEnvelope & {
  /** 仅含有截止日期的工作项 */
  total: number
  onTime: number
  rate: number | null
}

/** 值报告：全部为团队级聚合，无个人数据 */
export type ValueReport = {
  period: Period
  projects: ProjectMetrics
  sprints: SprintMetrics
  issues: IssueMetrics
  cycleTime: CycleTimeMetrics
  collaboration: CollaborationMetrics
  planFulfillment: PlanFulfillmentMetrics
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
