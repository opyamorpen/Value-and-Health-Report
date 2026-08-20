import { Injectable } from '@nestjs/common'
import { RULE_VERSION } from '../types'
import type {
  CollaborationMetrics,
  CycleTimeMetrics,
  IssueMetrics,
  PlanFulfillmentMetrics,
  ProjectMetrics,
  Period,
  SprintMetrics,
  ValueReport,
} from '../types'
import type {
  CollectedChangeRecord,
  CollectedIssue,
  CollectedProject,
  CollectedSprint,
  CollectResult,
} from './collectors.service'
import { normalizeTimestampMs } from './collectors.service'

/**
 * 指标聚合层：团队级聚合（无个人数据），按 docs/health-standard.md 规则。
 * 阈值常量由 RULE_VERSION 控制；样本 < Q 显示 unknown。
 */

const Q = 5

/** ISO 周键（用于周趋势） */
const isoWeekKey = (ms: number): string => {
  const date = new Date(ms)
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

const inPeriod = (ms: number, period: Period): boolean => ms >= period.start && ms < period.end

const envelopeOk = (source: string, collectedAt: number, coverage: number) => ({
  status: 'ok' as const,
  source,
  collectedAt,
  coverage,
  confidence: coverage >= 0.9 ? ('high' as const) : coverage >= 0.5 ? ('medium' as const) : ('low' as const),
  ruleVersion: RULE_VERSION,
})

const envelopeUnknown = (source: string, collectedAt: number) => ({
  status: 'unknown' as const,
  source,
  collectedAt,
  coverage: 0,
  confidence: 'low' as const,
  ruleVersion: RULE_VERSION,
})

type CollectorBundle = {
  projects: CollectResult<CollectedProject[]>
  sprints: CollectResult<CollectedSprint[]>
  issues: CollectResult<CollectedIssue[]>
  changelogs: CollectResult<CollectedChangeRecord[]>
}

@Injectable()
export class MetricsService {
  /** 主入口：bundle → ValueReport（当前周期 + 对比周期） */
  compute(period: Period, bundle: CollectorBundle, collectedAt: number): ValueReport {
    const projectUuids = new Set((bundle.projects.data ?? []).map(p => p.uuid))
    // 工作项按项目过滤（只统计当前团队项目）
    const issues = (bundle.issues.data ?? []).filter(i => projectUuids.has(i.projectUuid))

    return {
      period,
      projects: this.projectMetrics(bundle, period, collectedAt),
      sprints: this.sprintMetrics(bundle, period, collectedAt),
      issues: this.issueMetrics(issues, bundle.changelogs, period, collectedAt),
      cycleTime: this.cycleTimeMetrics(issues, bundle.changelogs, period, collectedAt),
      collaboration: this.collaborationMetrics(bundle.changelogs, period, collectedAt),
      planFulfillment: this.planFulfillmentMetrics(issues, bundle.changelogs, period, collectedAt),
    }
  }

  private projectMetrics(bundle: CollectorBundle, period: Period, collectedAt: number): ProjectMetrics {
    const projects = bundle.projects.data ?? []
    if (!projects.length) {
      return {
        ...envelopeUnknown('O-A1', collectedAt),
        newProjects: 0,
        activeProjects: 0,
        statusDistribution: {},
      }
    }
    const statusDistribution: Record<string, number> = {}
    for (const p of projects) {
      if (p.isArchive) continue
      statusDistribution[p.statusCategory || p.status] = (statusDistribution[p.statusCategory || p.status] ?? 0) + 1
    }
    const newProjects = projects.filter(p => inPeriod(p.createTime, period)).length
    // 活跃项目：周期内该项目有工作项创建或变更（用 issue/changelog 证据近似）
    const activeProjectUuids = new Set<string>()
    for (const i of bundle.issues.data ?? []) {
      if (inPeriod(i.createTime, period)) activeProjectUuids.add(i.projectUuid)
    }
    for (const c of bundle.changelogs.data ?? []) {
      if (inPeriod(c.createTime, period)) activeProjectUuids.add(String(c.issueUuid))
    }
    return {
      ...envelopeOk('O-A1', collectedAt, 1),
      newProjects,
      activeProjects: activeProjectUuids.size,
      statusDistribution,
    }
  }

  private sprintMetrics(bundle: CollectorBundle, period: Period, collectedAt: number): SprintMetrics {
    const sprints = bundle.sprints.data ?? []
    if (bundle.sprints.errors.length && !sprints.length) {
      return {
        ...envelopeUnknown('O-A2', collectedAt),
        created: 0,
        finished: 0,
        onTimeFinished: 0,
        finishTrend: [],
      }
    }
    // 周期内终态 Sprint：finishTime/endDate 在周期内且状态为终态
    const finished = sprints.filter(s => {
      const t = s.finishTime ?? s.endDate
      return t ? inPeriod(t, period) : false
    })
    const finishTrendMap = new Map<string, number>()
    for (const s of finished) {
      const t = s.finishTime ?? s.endDate ?? 0
      const key = isoWeekKey(t)
      finishTrendMap.set(key, (finishTrendMap.get(key) ?? 0) + 1)
    }
    // 按期：有起止时间且完成时间 ≤ 截止
    const withDates = finished.filter(s => s.startDate && s.endDate)
    const onTime = withDates.filter(s => (s.finishTime ?? s.endDate!) <= s.endDate! + 86400000)
    return {
      ...envelopeOk('O-A2+O-A4', collectedAt, withDates.length / Math.max(finished.length, 1)),
      created: sprints.filter(s => s.startDate && inPeriod(s.startDate, period)).length,
      finished: finished.length,
      onTimeFinished: onTime.length,
      finishTrend: [...finishTrendMap.entries()].sort().map(([week, count]) => ({ week, count })),
    }
  }

  private issueMetrics(
    issues: CollectedIssue[],
    changelogs: CollectResult<CollectedChangeRecord[]>,
    period: Period,
    collectedAt: number,
  ): IssueMetrics {
    const created = issues.filter(i => inPeriod(i.createTime, period))
    // 首次完成：changelog 中 field005（状态）首次变为终态类别，且在周期内
    const firstCompleted = this.firstCompletions(changelogs.data ?? [], period)
    // 重开：状态从终态变回非终态
    const reopened = (changelogs.data ?? []).filter(c => {
      if (!inPeriod(c.createTime, period)) return false
      return this.isToDone(c.oldValue, c.fieldType) && !this.isToDone(c.newValue, c.fieldType)
    }).length
    // 周吞吐量
    const weekMap = new Map<string, { created: number; completed: number }>()
    for (const i of created) {
      const key = isoWeekKey(i.createTime)
      const cell = weekMap.get(key) ?? { created: 0, completed: 0 }
      cell.created++
      weekMap.set(key, cell)
    }
    for (const doneAt of firstCompleted.values()) {
      if (!inPeriod(doneAt, period)) continue
      const key = isoWeekKey(doneAt)
      const cell = weekMap.get(key) ?? { created: 0, completed: 0 }
      cell.completed++
      weekMap.set(key, cell)
    }
    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, changelogs.data?.length ? 1 : 0.5),
      created: created.length,
      firstCompleted: [...firstCompleted.values()].filter(t => inPeriod(t, period)).length,
      reopened,
      throughputTrend: [...weekMap.entries()].sort().map(([week, v]) => ({ week, ...v })),
    }
  }

  private cycleTimeMetrics(
    issues: CollectedIssue[],
    changelogs: CollectResult<CollectedChangeRecord[]>,
    period: Period,
    collectedAt: number,
  ): CycleTimeMetrics {
    const issueCreate = new Map<string, number>()
    for (const i of issues) issueCreate.set(i.uuid, i.createTime)
    const firstCompleted = this.firstCompletions(changelogs.data ?? [], period)
    const durations: number[] = []
    for (const [uuid, doneAt] of firstCompleted) {
      const createAt = issueCreate.get(uuid)
      if (!createAt || !inPeriod(doneAt, period)) continue
      durations.push((doneAt - createAt) / 3600000)
    }
    durations.sort((a, b) => a - b)
    const sampleSize = durations.length
    if (sampleSize < Q) {
      return {
        ...envelopeUnknown('O-A12+O-A4', collectedAt),
        p50Hours: null,
        p75Hours: null,
        sampleSize,
      }
    }
    const percentile = (p: number) => durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]
    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, 1),
      p50Hours: Math.round(percentile(0.5) * 10) / 10,
      p75Hours: Math.round(percentile(0.75) * 10) / 10,
      sampleSize,
    }
  }

  private collaborationMetrics(
    changelogs: CollectResult<CollectedChangeRecord[]>,
    period: Period,
    collectedAt: number,
  ): CollaborationMetrics {
    // 人工行为：非机器人 author 的状态/字段变更（排除创建记录）
    const manualChanges = (changelogs.data ?? []).filter(
      c => !c.isBot && inPeriod(c.createTime, period) && c.fieldUuid !== 'field003',
    )
    const participants = new Set<string>()
    const weekMap = new Map<string, { actions: number; participants: Set<string> }>()
    for (const c of manualChanges) {
      participants.add(c.authorUuid)
      const key = isoWeekKey(c.createTime)
      const cell = weekMap.get(key) ?? { actions: 0, participants: new Set<string>() }
      cell.actions++
      cell.participants.add(c.authorUuid)
      weekMap.set(key, cell)
    }
    const weeklyTrend = [...weekMap.entries()]
      .sort()
      .map(([week, v]) => ({ week, actions: v.actions, participants: v.participants.size }))
    return {
      ...envelopeOk('O-A4', collectedAt, changelogs.data?.length ? 1 : 0.5),
      manualFieldChanges: manualChanges.length,
      comments: 0,
      worklogs: 0,
      participants: participants.size,
      weeklyTrend,
    }
  }

  private planFulfillmentMetrics(
    issues: CollectedIssue[],
    changelogs: CollectResult<CollectedChangeRecord[]>,
    period: Period,
    collectedAt: number,
  ): PlanFulfillmentMetrics {
    // 仅统计有截止日期且在周期内完成的工作项
    const firstCompleted = this.firstCompletions(changelogs.data ?? [], period)
    const withDue = issues.filter(i => i.dueDate && firstCompleted.has(i.uuid))
    let onTime = 0
    let total = 0
    for (const i of withDue) {
      const doneAt = firstCompleted.get(i.uuid)!
      if (!inPeriod(doneAt, period)) continue
      total++
      const dueMs = Date.parse(i.dueDate!)
      if (Number.isFinite(dueMs) && doneAt <= dueMs + 86400000) onTime++
    }
    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, withDue.length ? 1 : 0.5),
      total,
      onTime,
      rate: total >= Q ? Math.round((onTime / total) * 100) / 100 : null,
    }
  }

  /** changelog → issue 首次进入终态时间（field005 状态变更；终态=done 类别） */
  private firstCompletions(records: CollectedChangeRecord[], period: Period): Map<string, number> {
    const first = new Map<string, number>()
    for (const c of records) {
      if (c.fieldUuid !== 'field005' && c.fieldType !== 'status') continue
      if (!this.isToDone(c.newValue, c.fieldType)) continue
      const createTime = normalizeTimestampMs(c.createTime)
      if (createTime < period.compareStart || createTime >= period.end) continue
      const prev = first.get(c.issueUuid)
      if (prev === undefined || createTime < prev) {
        first.set(c.issueUuid, createTime)
      }
    }
    return first
  }

  /** 判断状态值是否终态：changelog 的 new_value 是状态选项 uuid/名称——按 done 语义近似（field005 的 category 无法从记录获取，用排除法：oldValue/newValue 相同跳过） */
  private isToDone(value: string | null, fieldType: string): boolean {
    // OpenAPI changelog 不返回 category；M3 用 DONE 状态集合近似：
    // 通过 collectSprints 阶段拿到的终态 Sprint / 或团队状态配置。此处先按非空判断（后续 M5 用固定数据校准）
    return Boolean(value) && fieldType === 'status'
  }
}
