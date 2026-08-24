import { Injectable } from '@nestjs/common'
import { RULE_VERSION, compareValues } from '../types'
import type {
  CollaborationMetrics,
  Compared,
  DefectMetrics,
  DeliveryEfficiencyMetrics,
  DisciplineMetrics,
  KnowledgeMetrics,
  Period,
  RequirementMetrics,
  ScopeMetrics,
  SprintExecutionMetrics,
  ValueReport,
  WorklogPracticeMetrics,
} from '../types'
import type {
  CollectedChangeRecord,
  CollectedEstimate,
  CollectedIssue,
  CollectedIssueType,
  CollectedProject,
  CollectedSprint,
  CollectedSpent,
  CollectResult,
} from './collectors.service'
import { classifyIssueType, isBotName, normalizeTimestampMs } from './collectors.service'

/**
 * 指标聚合层 v0.2（docs/value-standard.md）：双周期环比 + 四轴九维度 + 价值亮点。
 * 团队级聚合（无个人数据）；阈值由 RULE_VERSION 控制；样本 < Q 显示未知。
 */

const Q = 5
const DAY = 86400000

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

type Window = { start: number; end: number }
const currentWindow = (period: Period): Window => ({ start: period.start, end: period.end })
const compareWindow = (period: Period): Window => ({ start: period.compareStart, end: period.compareEnd })

const inWindow = (ms: number, w: Window): boolean => ms >= w.start && ms < w.end

const weeksBetween = (w: Window): number => Math.max(1, Math.round((w.end - w.start) / (7 * DAY)))

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
  issueTypes: CollectResult<CollectedIssueType[]>
  issues: CollectResult<CollectedIssue[]>
  changelogs: CollectResult<CollectedChangeRecord[]>
  estimates: CollectResult<CollectedEstimate[]>
  spent: CollectResult<CollectedSpent[]>
  wikiSpaceCount: CollectResult<number>
}

type IssueContext = {
  /** window 内创建的工作项 */
  created: CollectedIssue[]
  /** issueUuid → 首次终态时间（changelog 推导，窗口边界宽容处理） */
  firstDone: Map<string, number>
}

type SprintWindowStats = {
  finished: number
  onTimeFinished: number
  withDates: number
  deliveredItems: number
  cadenceWeeks: Set<string>
  lengthDays: number[]
}

@Injectable()
export class MetricsService {
  /** 主入口：bundle → ValueReport（当前周期 + 对比周期环比，value-standard v0.2） */
  compute(period: Period, bundle: CollectorBundle, collectedAt: number): ValueReport {
    const projectUuids = new Set((bundle.projects.data ?? []).map(p => p.uuid))
    const issues = (bundle.issues.data ?? []).filter(i => projectUuids.has(i.projectUuid))
    const changelogs = bundle.changelogs.data ?? []
    const typeMap = this.buildTypeMap(bundle.issueTypes.data ?? [], issues)

    const cur = currentWindow(period)
    const prev = compareWindow(period)

    // changelog 扫描窗口必须覆盖对比周期起点（首次完成归属口径）
    const firstDoneAll = this.firstCompletions(changelogs, period.compareStart, period.end)

    const curCtx: IssueContext = { created: issues.filter(i => inWindow(i.createTime, cur)), firstDone: firstDoneAll }
    const prevCtx: IssueContext = { created: issues.filter(i => inWindow(i.createTime, prev)), firstDone: firstDoneAll }

    const requirement = this.requirementMetrics(typeMap, curCtx, prevCtx, cur, prev, collectedAt, changelogs)
    const defect = this.defectMetrics(typeMap, issues, curCtx, prevCtx, cur, prev, collectedAt, changelogs)
    const sprintExecution = this.sprintExecutionMetrics(bundle.sprints, issues, cur, prev, collectedAt)
    const delivery = this.deliveryEfficiencyMetrics(changelogs, curCtx, prevCtx, cur, prev, collectedAt)
    const collaboration = this.collaborationMetrics(changelogs, cur, prev, collectedAt)
    const discipline = this.disciplineMetrics(curCtx, prevCtx, bundle.sprints, cur, prev, collectedAt)
    const worklog = this.worklogMetrics(curCtx, prevCtx, bundle, collectedAt)
    const knowledge = this.knowledgeMetrics(curCtx, prevCtx, bundle, collectedAt)
    const scope = this.scopeMetrics(bundle, issues, changelogs, cur, prev, collectedAt)

    const { highlights, concerns } = this.buildHighlights({
      requirement,
      defect,
      sprintExecution,
      deliveryEfficiency: delivery,
      collaboration,
      discipline,
      worklogPractice: worklog,
      knowledge,
    })

    return {
      period,
      scope,
      requirement,
      defect,
      sprintExecution,
      deliveryEfficiency: delivery,
      collaboration,
      discipline,
      worklogPractice: worklog,
      knowledge,
      highlights,
      concerns,
    }
  }

  // ---------- 类型映射 ----------

  private buildTypeMap(types: CollectedIssueType[], issues: CollectedIssue[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const t of types) map.set(t.uuid, classifyIssueType(t.name))
    // 类型清单不可用时：用标题关键词兜底（弱映射，mappingCoverage 如实反映）
    if (!types.length) {
      for (const i of issues) map.set(i.uuid, 'unclassified')
    }
    return map
  }

  private categoryOf(issue: CollectedIssue, typeMap: Map<string, string>): string {
    return typeMap.get(issue.issueTypeUuid ?? '') ?? 'unclassified'
  }

  private mappingCoverage(issues: CollectedIssue[], typeMap: Map<string, string>): number | null {
    if (!issues.length) return null
    const classified = issues.filter(i => {
      const cat = this.categoryOf(i, typeMap)
      return cat === 'requirement' || cat === 'defect' || cat === 'task'
    }).length
    return Math.round((classified / issues.length) * 100) / 100
  }

  // ---------- 统计范围（背景） ----------

  private scopeMetrics(
    bundle: CollectorBundle,
    issues: CollectedIssue[],
    changelogs: CollectedChangeRecord[],
    cur: Window,
    prev: Window,
    collectedAt: number,
  ): ScopeMetrics {
    const projects = bundle.projects.data ?? []
    if (!projects.length) {
      return {
        ...envelopeUnknown('O-A1', collectedAt),
        activeProjects: compareValues('up', 0, null, 'count', 0),
        newProjects: 0,
      }
    }
    // 活跃项目：周期内有工作项创建或变更的项目集合（按 projectUuid 归并——v0.1 口径修正）
    const activeOf = (w: Window): number => {
      const uuids = new Set<string>()
      for (const i of issues) {
        if (inWindow(i.createTime, w)) uuids.add(i.projectUuid)
      }
      const issueProject = new Map(issues.map(i => [i.uuid, i.projectUuid]))
      for (const c of changelogs) {
        if (inWindow(normalizeTimestampMs(c.createTime), w)) {
          const p = issueProject.get(c.issueUuid)
          if (p) uuids.add(p)
        }
      }
      return uuids.size
    }
    const newProjects = projects.filter(p => inWindow(p.createTime, cur)).length
    return {
      ...envelopeOk('O-A1', collectedAt, 1),
      activeProjects: compareValues('up', activeOf(cur), activeOf(prev), 'count', activeOf(cur)),
      newProjects,
    }
  }

  // ---------- A1 需求与价值交付 ----------

  private requirementMetrics(
    typeMap: Map<string, string>,
    curCtx: IssueContext,
    prevCtx: IssueContext,
    cur: Window,
    prev: Window,
    collectedAt: number,
    changelogs: CollectedChangeRecord[],
  ): RequirementMetrics {
    const typeSplit = this.mappingCoverage([...curCtx.created, ...prevCtx.created], typeMap) != null
      && this.unclassifiedRate(curCtx, prevCtx, typeMap) <= 0.3
    if (!typeSplit) {
      // 降级：全类型口径（§4.1 映射覆盖率不足）
      return this.requirementFallback(curCtx, prevCtx, cur, prev, collectedAt, changelogs)
    }
    const reqOf = (ctx: IssueContext): CollectedIssue[] => ctx.created.filter(i => this.categoryOf(i, typeMap) === 'requirement')

    const createdCmp = compareValues('up', reqOf(curCtx).length, reqOf(prevCtx).length, 'count', reqOf(curCtx).length)

    const deliveredOf = (ctx: IssueContext, w: Window): number =>
      reqOf(ctx).filter(i => {
        const done = ctx.firstDone.get(i.uuid)
        return done != null && inWindow(done, w)
      }).length
    const deliveredCmp = compareValues('up', deliveredOf(curCtx, cur), deliveredOf(prevCtx, prev), 'count', deliveredOf(curCtx, cur))

    const cycleOf = (ctx: IssueContext, w: Window): number[] => {
      const durations: number[] = []
      for (const i of reqOf(ctx)) {
        const done = ctx.firstDone.get(i.uuid)
        if (done == null || !inWindow(done, w)) continue
        durations.push((done - i.createTime) / 3600000)
      }
      return durations.sort((a, b) => a - b)
    }
    const cycleCmp = this.cycleCompare(cycleOf(curCtx, cur), cycleOf(prevCtx, prev))

    const onTimeOf = (ctx: IssueContext, w: Window): { onTime: number; total: number } => {
      let onTime = 0
      let total = 0
      for (const i of reqOf(ctx)) {
        if (!i.dueDate) continue
        const done = ctx.firstDone.get(i.uuid)
        if (done == null || !inWindow(done, w)) continue
        total++
        const dueMs = Date.parse(i.dueDate)
        if (Number.isFinite(dueMs) && done <= dueMs + DAY) onTime++
      }
      return { onTime, total }
    }
    const curOnTime = onTimeOf(curCtx, cur)
    const prevOnTime = onTimeOf(prevCtx, prev)
    const onTimeRate = compareValues(
      'up',
      curOnTime.total >= Q ? curOnTime.onTime / curOnTime.total : null,
      prevOnTime.total >= Q ? prevOnTime.onTime / prevOnTime.total : null,
      'ratio',
      Math.min(curOnTime.total, prevOnTime.total),
    )

    // 迭代纳入率：交付的需求中关联过迭代（sprintUuid 非空）
    const linkedOf = (ctx: IssueContext, w: Window): { linked: number; total: number } => {
      let linked = 0
      let total = 0
      for (const i of reqOf(ctx)) {
        const done = ctx.firstDone.get(i.uuid)
        if (done == null || !inWindow(done, w)) continue
        total++
        if (i.sprintUuid) linked++
      }
      return { linked, total }
    }
    const curLinked = linkedOf(curCtx, cur)
    const prevLinked = linkedOf(prevCtx, prev)
    const sprintLinkedRate = compareValues(
      'up',
      curLinked.total >= Q ? curLinked.linked / curLinked.total : null,
      prevLinked.total >= Q ? prevLinked.linked / prevLinked.total : null,
      'ratio',
      Math.min(curLinked.total, prevLinked.total),
    )

    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, changelogs.length ? 1 : 0.5),
      typeSplit: true,
      mappingCoverage: this.mappingCoverage([...curCtx.created, ...prevCtx.created], typeMap),
      created: createdCmp,
      delivered: deliveredCmp,
      cycleP50Hours: cycleCmp.p50,
      onTimeRate,
      sprintLinkedRate,
    }
  }

  private requirementFallback(
    curCtx: IssueContext,
    prevCtx: IssueContext,
    cur: Window,
    prev: Window,
    collectedAt: number,
    changelogs: CollectedChangeRecord[],
  ): RequirementMetrics {
    // 全类型口径（映射不可用降级）
    const deliveredOf = (ctx: IssueContext, w: Window): number =>
      ctx.created.filter(i => {
        const done = ctx.firstDone.get(i.uuid)
        return done != null && inWindow(done, w)
      }).length
    const nullCmp = compareValues('up', null, null, 'ratio', 0)
    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, changelogs.length ? 1 : 0.5),
      typeSplit: false,
      mappingCoverage: null,
      created: compareValues('up', curCtx.created.length, prevCtx.created.length, 'count', curCtx.created.length),
      delivered: compareValues('up', deliveredOf(curCtx, cur), deliveredOf(prevCtx, prev), 'count', deliveredOf(curCtx, cur)),
      cycleP50Hours: nullCmp,
      onTimeRate: nullCmp,
      sprintLinkedRate: nullCmp,
    }
  }

  private unclassifiedRate(curCtx: IssueContext, prevCtx: IssueContext, typeMap: Map<string, string>): number {
    const all = [...curCtx.created, ...prevCtx.created]
    if (!all.length) return 0
    const unclassified = all.filter(i => this.categoryOf(i, typeMap) === 'unclassified').length
    return unclassified / all.length
  }

  // ---------- A2 缺陷与质量 ----------

  private defectMetrics(
    typeMap: Map<string, string>,
    issues: CollectedIssue[],
    curCtx: IssueContext,
    prevCtx: IssueContext,
    cur: Window,
    prev: Window,
    collectedAt: number,
    changelogs: CollectedChangeRecord[],
  ): DefectMetrics {
    const typeSplit = this.unclassifiedRate(curCtx, prevCtx, typeMap) <= 0.3
    if (!typeSplit) {
      const nullCmp = compareValues('up', null, null, 'count', 0)
      return {
        ...envelopeUnknown('O-A12(type-split)', collectedAt),
        typeSplit: false,
        found: nullCmp,
        fixed: nullCmp,
        open: 0,
        fixCycleP50Hours: compareValues('down', null, null, 'count', 0),
        reopenRate: compareValues('down', null, null, 'ratio', 0),
      }
    }
    const defectsOf = (ctx: IssueContext): CollectedIssue[] => ctx.created.filter(i => this.categoryOf(i, typeMap) === 'defect')
    const curDefects = defectsOf(curCtx)
    const prevDefects = defectsOf(prevCtx)

    const fixedOf = (defects: CollectedIssue[], w: Window): number =>
      defects.filter(i => {
        const done = curCtx.firstDone.get(i.uuid) ?? prevCtx.firstDone.get(i.uuid)
        return done != null && inWindow(done, w)
      }).length

    const fixCycleOf = (defects: CollectedIssue[], w: Window): number[] => {
      const durations: number[] = []
      for (const i of defects) {
        const done = curCtx.firstDone.get(i.uuid) ?? prevCtx.firstDone.get(i.uuid)
        if (done == null || !inWindow(done, w)) continue
        durations.push((done - i.createTime) / 3600000)
      }
      return durations.sort((a, b) => a - b)
    }

    // 重开率：周期内缺陷终态→非终态次数 / 缺陷首次完成数
    const reopenedIn = (w: Window): number =>
      changelogs.filter(c => {
        if (!inWindow(normalizeTimestampMs(c.createTime), w)) return false
        const issue = issues.find(i => i.uuid === c.issueUuid)
        if (!issue || this.categoryOf(issue, typeMap) !== 'defect') return false
        return this.isToDone(c.oldValue, c.fieldType) && !this.isToDone(c.newValue, c.fieldType)
      }).length
    const curFixed = fixedOf(curDefects, cur)
    const prevFixed = fixedOf(prevDefects, prev)
    const reopenRate = compareValues(
      'down',
      curFixed >= Q ? reopenedIn(cur) / curFixed : null,
      prevFixed >= Q ? reopenedIn(prev) / prevFixed : null,
      'ratio',
      Math.min(curFixed, prevFixed),
    )

    // 遗留：周期内创建、报告生成时点仍非终态（changelog 未见终态记录）
    const open = curDefects.filter(i => !curCtx.firstDone.has(i.uuid)).length

    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, changelogs.length ? 1 : 0.5),
      typeSplit: true,
      found: compareValues('neutral', curDefects.length, prevDefects.length, 'count', curDefects.length),
      fixed: compareValues('up', curFixed, prevFixed, 'count', curFixed),
      open,
      fixCycleP50Hours: this.cycleCompare(fixCycleOf(curDefects, cur), fixCycleOf(prevDefects, prev)).p50,
      reopenRate,
    }
  }

  // ---------- A3 敏捷迭代执行 ----------

  private sprintExecutionMetrics(
    sprints: CollectResult<CollectedSprint[]>,
    issues: CollectedIssue[],
    cur: Window,
    prev: Window,
    collectedAt: number,
  ): SprintExecutionMetrics {
    const list = sprints.data ?? []
    if (sprints.errors.length && !list.length) {
      const nullCmp = compareValues('up', null, null, 'count', 0)
      return {
        ...envelopeUnknown('O-A2', collectedAt),
        finished: nullCmp,
        onTimeRate: compareValues('up', null, null, 'ratio', 0),
        deliveredItems: nullCmp,
        cadenceWeeks: 0,
        finishTrend: [],
      }
    }
    // 终态 Sprint（§4.2 口径修正：status 终态或 finishTime 非空）
    const isFinished = (s: CollectedSprint): boolean =>
      this.isDoneStatus(s.status) || s.finishTime != null
    const finishedOf = (w: Window): CollectedSprint[] =>
      list.filter(s => {
        if (!isFinished(s)) return false
        const t = s.finishTime ?? s.endDate
        return t ? inWindow(t, w) : false
      })

    const statsOf = (w: Window): SprintWindowStats => {
      const finished = finishedOf(w)
      const withDates = finished.filter(s => s.startDate && s.endDate)
      const onTime = withDates.filter(s => (s.finishTime ?? s.endDate!) <= s.endDate! + DAY)
      const finishedUuids = new Set(finished.map(s => s.uuid))
      const deliveredItems = issues.filter(i => i.sprintUuid && finishedUuids.has(i.sprintUuid)).length
      const cadenceWeeks = new Set(finished.map(s => isoWeekKey(s.finishTime ?? s.endDate ?? 0)))
      const lengthDays = withDates.map(s => ((s.endDate! - s.startDate!) / DAY))
      return { finished: finished.length, onTimeFinished: onTime.length, withDates: withDates.length, deliveredItems, cadenceWeeks, lengthDays }
    }

    const curStats = statsOf(cur)
    const prevStats = statsOf(prev)

    const finishTrendMap = new Map<string, number>()
    for (const s of finishedOf(cur)) {
      const t = s.finishTime ?? s.endDate ?? 0
      const key = isoWeekKey(t)
      finishTrendMap.set(key, (finishTrendMap.get(key) ?? 0) + 1)
    }

    return {
      ...envelopeOk('O-A2+O-A12', collectedAt, curStats.withDates ? 1 : 0.5),
      finished: compareValues('up', curStats.finished, prevStats.finished, 'count', curStats.finished),
      onTimeRate: compareValues(
        'up',
        curStats.withDates >= Q ? curStats.onTimeFinished / curStats.withDates : null,
        prevStats.withDates >= Q ? prevStats.onTimeFinished / prevStats.withDates : null,
        'ratio',
        Math.min(curStats.withDates, prevStats.withDates),
      ),
      deliveredItems: compareValues('up', curStats.deliveredItems, prevStats.deliveredItems, 'count', curStats.deliveredItems),
      cadenceWeeks: curStats.cadenceWeeks.size,
      finishTrend: [...finishTrendMap.entries()].sort().map(([week, count]) => ({ week, count })),
    }
  }

  // ---------- B1 交付效率 + B2 计划兑现 ----------

  private deliveryEfficiencyMetrics(
    changelogs: CollectedChangeRecord[],
    curCtx: IssueContext,
    prevCtx: IssueContext,
    cur: Window,
    prev: Window,
    collectedAt: number,
  ): DeliveryEfficiencyMetrics {
    const cycleOf = (ctx: IssueContext, w: Window): number[] => {
      const durations: number[] = []
      for (const i of ctx.created) {
        const done = ctx.firstDone.get(i.uuid)
        if (done == null || !inWindow(done, w)) continue
        durations.push((done - i.createTime) / 3600000)
      }
      return durations.sort((a, b) => a - b)
    }
    const cycle = this.cycleCompare(cycleOf(curCtx, cur), cycleOf(prevCtx, prev))

    // 周均完成吞吐
    const completedIn = (w: Window): number => {
      let n = 0
      for (const [, doneAt] of curCtx.firstDone) {
        if (inWindow(doneAt, w)) n++
      }
      return n
    }
    const curWeeks = weeksBetween(cur)
    const prevWeeks = weeksBetween(prev)
    const weeklyThroughput = compareValues(
      'up',
      Math.round((completedIn(cur) / curWeeks) * 10) / 10,
      Math.round((completedIn(prev) / prevWeeks) * 10) / 10,
      'count',
      Math.min(completedIn(cur), completedIn(prev)),
    )

    // 按期完成率（有截止日期项）
    const onTimeOf = (ctx: IssueContext, w: Window): { onTime: number; total: number } => {
      let onTime = 0
      let total = 0
      for (const i of ctx.created) {
        if (!i.dueDate) continue
        const done = ctx.firstDone.get(i.uuid)
        if (done == null || !inWindow(done, w)) continue
        total++
        const dueMs = Date.parse(i.dueDate)
        if (Number.isFinite(dueMs) && done <= dueMs + DAY) onTime++
      }
      return { onTime, total }
    }
    const curOT = onTimeOf(curCtx, cur)
    const prevOT = onTimeOf(prevCtx, prev)
    const onTimeRate = compareValues(
      'up',
      curOT.total >= Q ? curOT.onTime / curOT.total : null,
      prevOT.total >= Q ? prevOT.onTime / prevOT.total : null,
      'ratio',
      Math.min(curOT.total, prevOT.total),
    )

    // 重开率（全类型）
    const reopenedIn = (w: Window): number =>
      changelogs.filter(c => {
        if (!inWindow(normalizeTimestampMs(c.createTime), w)) return false
        return this.isToDone(c.oldValue, c.fieldType) && !this.isToDone(c.newValue, c.fieldType)
      }).length
    const curCompleted = completedIn(cur)
    const prevCompleted = completedIn(prev)
    const reopenRate = compareValues(
      'down',
      curCompleted >= Q ? reopenedIn(cur) / curCompleted : null,
      prevCompleted >= Q ? reopenedIn(prev) / prevCompleted : null,
      'ratio',
      Math.min(curCompleted, prevCompleted),
    )

    // 吞吐趋势（当前周期按周）
    const weekMap = new Map<string, { created: number; completed: number }>()
    for (const i of curCtx.created) {
      const key = isoWeekKey(i.createTime)
      const cell = weekMap.get(key) ?? { created: 0, completed: 0 }
      cell.created++
      weekMap.set(key, cell)
    }
    for (const [, doneAt] of curCtx.firstDone) {
      if (!inWindow(doneAt, cur)) continue
      const key = isoWeekKey(doneAt)
      const cell = weekMap.get(key) ?? { created: 0, completed: 0 }
      cell.completed++
      weekMap.set(key, cell)
    }

    return {
      ...envelopeOk('O-A12+O-A4', collectedAt, changelogs.length ? 1 : 0.5),
      cycleP50Hours: cycle.p50,
      cycleP75Hours: cycle.p75,
      weeklyThroughput,
      onTimeRate,
      reopenRate,
      throughputTrend: [...weekMap.entries()].sort().map(([week, v]) => ({ week, ...v })),
    }
  }

  // ---------- C1 协作参与 ----------

  private collaborationMetrics(
    changelogs: CollectedChangeRecord[],
    cur: Window,
    prev: Window,
    collectedAt: number,
  ): CollaborationMetrics {
    // 人工行为：非机器人 author 的状态/字段变更（排除创建记录 field003）
    const manualChanges = changelogs.filter(
      c => !isBotName(c.authorName) && c.fieldUuid !== 'field003',
    )
    const statsOf = (w: Window): { actions: number; participants: Set<string>; weeks: Set<string> } => {
      const participants = new Set<string>()
      const weeks = new Set<string>()
      let actions = 0
      for (const c of manualChanges) {
        const t = normalizeTimestampMs(c.createTime)
        if (!inWindow(t, w)) continue
        actions++
        participants.add(c.authorUuid)
        weeks.add(isoWeekKey(t))
      }
      return { actions, participants, weeks }
    }
    const curStats = statsOf(cur)
    const prevStats = statsOf(prev)

    // 周趋势（当前周期）
    const weekMap = new Map<string, { actions: number; participants: Set<string> }>()
    for (const c of manualChanges) {
      const t = normalizeTimestampMs(c.createTime)
      if (!inWindow(t, cur)) continue
      const key = isoWeekKey(t)
      const cell = weekMap.get(key) ?? { actions: 0, participants: new Set<string>() }
      cell.actions++
      cell.participants.add(c.authorUuid)
      weekMap.set(key, cell)
    }

    return {
      ...envelopeOk('O-A4', collectedAt, changelogs.length ? 1 : 0.5),
      participants: compareValues('up', curStats.participants.size, prevStats.participants.size, 'count', curStats.participants.size),
      manualActions: compareValues('up', curStats.actions, prevStats.actions, 'count', curStats.actions),
      activeWeeks: curStats.weeks.size,
      weeklyTrend: [...weekMap.entries()]
        .sort()
        .map(([week, v]) => ({ week, actions: v.actions, participants: v.participants.size })),
    }
  }

  // ---------- C2 管理规范度 ----------

  private disciplineMetrics(
    curCtx: IssueContext,
    prevCtx: IssueContext,
    sprints: CollectResult<CollectedSprint[]>,
    cur: Window,
    prev: Window,
    collectedAt: number,
  ): DisciplineMetrics {
    // 信息完整率：周期内创建项中有负责人/截止日期的占比
    const fillOf = (ctx: IssueContext, pick: (i: CollectedIssue) => boolean): number | null => {
      if (ctx.created.length < Q) return null
      const filled = ctx.created.filter(pick).length
      return filled / ctx.created.length
    }
    const curAssignee = fillOf(curCtx, i => Boolean(i.assigneeUuid))
    const prevAssignee = fillOf(prevCtx, i => Boolean(i.assigneeUuid))
    const curDue = fillOf(curCtx, i => i.dueDate != null)
    const prevDue = fillOf(prevCtx, i => i.dueDate != null)

    // 迭代规范：周期内终态 Sprint 中有起止日期的占比 + 迭代长度中位数
    const list = sprints.data ?? []
    const isFinished = (s: CollectedSprint): boolean => this.isDoneStatus(s.status) || s.finishTime != null
    const finishedIn = (w: Window): CollectedSprint[] =>
      list.filter(s => {
        if (!isFinished(s)) return false
        const t = s.finishTime ?? s.endDate
        return t ? inWindow(t, w) : false
      })
    const sprintDisciplineOf = (w: Window): number | null => {
      const finished = finishedIn(w)
      if (finished.length < Q) return null
      return finished.filter(s => s.startDate && s.endDate).length / finished.length
    }
    const curSprintDisc = sprintDisciplineOf(cur)
    const prevSprintDisc = sprintDisciplineOf(prev)

    const lengths = finishedIn(cur)
      .filter(s => s.startDate && s.endDate)
      .map(s => (s.endDate! - s.startDate!) / DAY)
      .sort((a, b) => a - b)
    const sprintLengthMedian = lengths.length ? Math.round(lengths[Math.floor(lengths.length / 2)] * 10) / 10 : null

    return {
      ...envelopeOk('O-A12+O-A2', collectedAt, curCtx.created.length ? 1 : 0.5),
      assigneeFillRate: compareValues('up', curAssignee, prevAssignee, 'ratio', Math.min(curCtx.created.length, prevCtx.created.length)),
      dueDateFillRate: compareValues('up', curDue, prevDue, 'ratio', Math.min(curCtx.created.length, prevCtx.created.length)),
      sprintDateDisciplineRate: compareValues(
        'up',
        curSprintDisc,
        prevSprintDisc,
        'ratio',
        Math.min(finishedIn(cur).length, finishedIn(prev).length),
      ),
      sprintLengthMedianDays: sprintLengthMedian,
    }
  }

  // ---------- C3 工时实践 ----------

  private worklogMetrics(
    curCtx: IssueContext,
    prevCtx: IssueContext,
    bundle: CollectorBundle,
    collectedAt: number,
  ): WorklogPracticeMetrics {
    const estimates = bundle.estimates.data ?? []
    const spent = bundle.spent.data ?? []
    const estimateMap = new Map<string, number>()
    for (const e of estimates) estimateMap.set(e.issueUuid, (estimateMap.get(e.issueUuid) ?? 0) + e.seconds)
    const spentMap = new Map<string, number>()
    for (const s of spent) spentMap.set(s.issueUuid, (spentMap.get(s.issueUuid) ?? 0) + s.seconds)

    const coverageOf = (ctx: IssueContext, map: Map<string, number>): number | null => {
      if (!ctx.created.length || ctx.created.length < Q) return null
      // 采样基数：spent 是采样数据（上限 500），覆盖率按已采样范围呈现
      const base = map === spentMap ? Math.min(ctx.created.length, bundle.spent.data?.length ? Math.max(...[ctx.created.length, 500]) : 500) : ctx.created.length
      void base
      const withValue = ctx.created.filter(i => (map.get(i.uuid) ?? 0) > 0).length
      if (map === spentMap) {
        // spent 为采样口径：以采样到的 issue 为分母近似
        const sampledInCtx = ctx.created.filter(i => spentMap.has(i.uuid) || spent.length === 0)
        if (sampledInCtx.length < Q) return null
        return withValue / sampledInCtx.length
      }
      return withValue / ctx.created.length
    }
    const curEst = coverageOf(curCtx, estimateMap)
    const prevEst = coverageOf(prevCtx, estimateMap)
    const curSpent = coverageOf(curCtx, spentMap)
    const prevSpent = coverageOf(prevCtx, spentMap)

    // 预估准确度：|实际-预估|/预估 中位数（仅两者齐备）
    const accuracy = this.estimateAccuracy(curCtx, estimateMap, spentMap)

    return {
      ...envelopeOk('O-A5+O-A6', collectedAt, estimates.length || spent.length ? 1 : 0.5),
      estimateCoverage: compareValues('up', curEst, prevEst, 'ratio', Math.min(curCtx.created.length, prevCtx.created.length)),
      spentCoverage: compareValues('up', curSpent, prevSpent, 'ratio', Math.min(curCtx.created.length, prevCtx.created.length)),
      estimateAccuracyMedian: accuracy.median,
      pairedSampleSize: accuracy.sampleSize,
    }
  }

  private estimateAccuracy(
    ctx: IssueContext,
    estimateMap: Map<string, number>,
    spentMap: Map<string, number>,
  ): { median: number | null; sampleSize: number } {
    const ratios: number[] = []
    for (const i of ctx.created) {
      const est = estimateMap.get(i.uuid)
      const sp = spentMap.get(i.uuid)
      if (!est || !sp || est <= 0) continue
      ratios.push(Math.abs(sp - est) / est)
    }
    if (ratios.length < Q) return { median: null, sampleSize: ratios.length }
    ratios.sort((a, b) => a - b)
    return { median: Math.round(ratios[Math.floor(ratios.length / 2)] * 100) / 100, sampleSize: ratios.length }
  }

  // ---------- D1 知识沉淀 ----------

  private knowledgeMetrics(
    curCtx: IssueContext,
    prevCtx: IssueContext,
    bundle: CollectorBundle,
    collectedAt: number,
  ): KnowledgeMetrics {
    const wikiOf = (ctx: IssueContext): { count: number; total: number } => ({
      count: ctx.created.filter(i => i.wikiLinked).length,
      total: ctx.created.length,
    })
    const curW = wikiOf(curCtx)
    const prevW = wikiOf(prevCtx)
    const wikiSpaces = bundle.wikiSpaceCount.data ?? null
    const source = wikiSpaces != null ? 'O-A12(field048)+O-A7' : 'O-A12(field048)'

    return {
      ...envelopeOk(source, collectedAt, curCtx.created.length ? 1 : 0.5),
      wikiLinkedCount: compareValues('up', curW.count, prevW.count, 'count', curW.count),
      wikiLinkedRate: compareValues(
        'up',
        curW.total >= Q ? curW.count / curW.total : null,
        prevW.total >= Q ? prevW.count / prevW.total : null,
        'ratio',
        Math.min(curW.total, prevW.total),
      ),
      wikiSpaces,
    }
  }

  // ---------- 价值亮点与需关注 ----------

  private buildHighlights(report: Omit<ValueReport, 'highlights' | 'concerns' | 'scope' | 'period'> & Partial<Pick<ValueReport, 'scope'>>): {
    highlights: Array<{ text: string; metric: string; kind: 'improvement' | 'new-practice' | 'achievement' }>
    concerns: Array<{ text: string; metric: string }>
  } {
    type Candidate = {
      metric: string
      label: string
      cmp: Compared
      kind: 'count' | 'ratio'
      suffix?: string
      /** down 类改善的动词 */
      improveVerb?: string
    }
    const candidates: Candidate[] = [
      { metric: 'requirement.delivered', label: '需求交付量', cmp: report.requirement.delivered, kind: 'count' },
      { metric: 'defect.fixed', label: '缺陷修复数', cmp: report.defect.fixed, kind: 'count' },
      { metric: 'sprintExecution.finished', label: '完成迭代数', cmp: report.sprintExecution.finished, kind: 'count' },
      { metric: 'deliveryEfficiency.cycleP50Hours', label: '交付周期中位数', cmp: report.deliveryEfficiency.cycleP50Hours, kind: 'count', suffix: ' 小时', improveVerb: '缩短' },
      { metric: 'requirement.cycleP50Hours', label: '需求交付周期中位数', cmp: report.requirement.cycleP50Hours, kind: 'count', suffix: ' 小时', improveVerb: '缩短' },
      { metric: 'defect.fixCycleP50Hours', label: '缺陷修复周期中位数', cmp: report.defect.fixCycleP50Hours, kind: 'count', suffix: ' 小时', improveVerb: '缩短' },
      { metric: 'deliveryEfficiency.weeklyThroughput', label: '周均完成吞吐', cmp: report.deliveryEfficiency.weeklyThroughput, kind: 'count' },
      { metric: 'deliveryEfficiency.onTimeRate', label: '按期完成率', cmp: report.deliveryEfficiency.onTimeRate, kind: 'ratio', suffix: '%' },
      { metric: 'sprintExecution.onTimeRate', label: '迭代按期完成率', cmp: report.sprintExecution.onTimeRate, kind: 'ratio', suffix: '%' },
      { metric: 'deliveryEfficiency.reopenRate', label: '重开率', cmp: report.deliveryEfficiency.reopenRate, kind: 'ratio', suffix: '%', improveVerb: '下降' },
      { metric: 'collaboration.participants', label: '协作参与人数', cmp: report.collaboration.participants, kind: 'count' },
      { metric: 'collaboration.manualActions', label: '人工协作行为', cmp: report.collaboration.manualActions, kind: 'count' },
      { metric: 'discipline.assigneeFillRate', label: '负责人填写率', cmp: report.discipline.assigneeFillRate, kind: 'ratio', suffix: '%' },
      { metric: 'discipline.dueDateFillRate', label: '截止日期填写率', cmp: report.discipline.dueDateFillRate, kind: 'ratio', suffix: '%' },
      { metric: 'worklogPractice.estimateCoverage', label: '工时预估覆盖率', cmp: report.worklogPractice.estimateCoverage, kind: 'ratio', suffix: '%' },
      { metric: 'knowledge.wikiLinkedRate', label: 'Wiki 知识沉淀率', cmp: report.knowledge.wikiLinkedRate, kind: 'ratio', suffix: '%' },
    ]

    const fmt = (v: number | null, kind: 'count' | 'ratio', suffix?: string): string =>
      v == null ? '未知' : kind === 'ratio' ? `${Math.round(v * 100)}${suffix ?? '%'}` : `${v}${suffix ?? ''}`

    const improvements: Candidate[] = []
    const newPractices: Candidate[] = []
    const regressions: Candidate[] = []
    for (const c of candidates) {
      if (c.cmp.direction === 'neutral') continue
      if (c.cmp.trendLabel === '新增' && c.cmp.isImprovement) {
        newPractices.push(c)
      } else if (
        c.cmp.isImprovement === true &&
        (c.cmp.trendLabel === '显著提升' || c.cmp.trendLabel === '显著下降')
      ) {
        improvements.push(c)
      } else if (
        c.cmp.isImprovement === false &&
        (c.cmp.trendLabel === '显著提升' || c.cmp.trendLabel === '显著下降')
      ) {
        regressions.push(c)
      }
    }

    const magnitude = (c: Candidate): number => {
      if (c.kind === 'ratio') return Math.abs(c.cmp.deltaPP ?? 0)
      if (c.cmp.deltaPercent != null) return Math.abs(c.cmp.deltaPercent)
      return 0
    }
    improvements.sort((a, b) => magnitude(b) - magnitude(a))
    newPractices.sort((a, b) => magnitude(b) - magnitude(a))
    regressions.sort((a, b) => magnitude(b) - magnitude(a))

    const highlights: Array<{ text: string; metric: string; kind: 'improvement' | 'new-practice' | 'achievement' }> = []
    for (const c of improvements.slice(0, 5)) {
      const from = fmt(c.cmp.previous, c.kind, c.suffix)
      const to = fmt(c.cmp.current, c.kind, c.suffix)
      if (c.kind === 'ratio') {
        highlights.push({
          text: `${c.label}提升 ${Math.abs(c.cmp.deltaPP ?? 0)} 个百分点（${from} → ${to}）`,
          metric: c.metric,
          kind: 'improvement',
        })
      } else if (c.cmp.direction === 'down') {
        highlights.push({
          text: `${c.label}${c.improveVerb ?? '下降'} ${Math.abs(c.cmp.deltaPercent ?? 0)}%（${from} → ${to}）`,
          metric: c.metric,
          kind: 'improvement',
        })
      } else {
        highlights.push({
          text: `${c.label}提升 ${Math.abs(c.cmp.deltaPercent ?? 0)}%（${from} → ${to}）`,
          metric: c.metric,
          kind: 'improvement',
        })
      }
    }
    for (const c of newPractices.slice(0, 1)) {
      highlights.push({
        text: `${c.label}实现零的突破（${fmt(c.cmp.previous, c.kind, c.suffix)} → ${fmt(c.cmp.current, c.kind, c.suffix)}）`,
        metric: c.metric,
        kind: 'new-practice',
      })
    }

    // 无显著改善：回退最大绝对成果（不硬凑）
    if (!highlights.length) {
      const achievements: Array<{ text: string; metric: string }> = []
      if (report.requirement.delivered.current != null && report.requirement.delivered.current > 0) {
        achievements.push({ text: `本周期交付需求 ${report.requirement.delivered.current} 个`, metric: 'requirement.delivered' })
      }
      if (report.defect.fixed.current != null && report.defect.fixed.current > 0) {
        achievements.push({ text: `修复缺陷 ${report.defect.fixed.current} 个`, metric: 'defect.fixed' })
      }
      if (report.collaboration.participants.current != null && report.collaboration.participants.current > 0) {
        achievements.push({
          text: `${report.collaboration.participants.current} 名成员参与协作，覆盖 ${report.collaboration.activeWeeks} 个自然周`,
          metric: 'collaboration.participants',
        })
      }
      for (const a of achievements.slice(0, 3)) {
        highlights.push({ ...a, kind: 'achievement' })
      }
    }

    const concerns = regressions.slice(0, 2).map(c => ({
      text:
        c.kind === 'ratio'
          ? `${c.label}变化 ${c.cmp.deltaPP ?? 0} 个百分点（${fmt(c.cmp.previous, c.kind, c.suffix)} → ${fmt(c.cmp.current, c.kind, c.suffix)}），建议关注`
          : `${c.label}变化 ${c.cmp.deltaPercent ?? 0}%（${fmt(c.cmp.previous, c.kind, c.suffix)} → ${fmt(c.cmp.current, c.kind, c.suffix)}），建议关注`,
      metric: c.metric,
    }))

    return { highlights, concerns }
  }

  // ---------- 通用 ----------

  private cycleCompare(cur: number[], prev: number[]): { p50: Compared; p75: Compared } {
    const p50Of = (durations: number[]): number | null =>
      durations.length >= Q ? Math.round(durations[Math.floor(durations.length / 2)] * 10) / 10 : null
    const p75Of = (durations: number[]): number | null =>
      durations.length >= Q ? Math.round(durations[Math.floor(durations.length * 0.75)] * 10) / 10 : null
    return {
      p50: compareValues('down', p50Of(cur), p50Of(prev), 'count', Math.min(cur.length, prev.length)),
      p75: compareValues('down', p75Of(cur), p75Of(prev), 'count', Math.min(cur.length, prev.length)),
    }
  }

  /** Sprint status 终态判定（T13 关键词约定同口径） */
  private isDoneStatus(status: string): boolean {
    return /done|完成|关闭|closed|resolved|finished|已结束/i.test(status)
  }

  /** changelog → issue 首次进入终态时间（field005 状态变更；终态=done 类别关键词约定 T13） */
  private firstCompletions(records: CollectedChangeRecord[], scanStart: number, scanEnd: number): Map<string, number> {
    const first = new Map<string, number>()
    for (const c of records) {
      if (c.fieldUuid !== 'field005' && c.fieldType !== 'status') continue
      if (!this.isToDone(c.newValue, c.fieldType)) continue
      const createTime = normalizeTimestampMs(c.createTime)
      if (createTime < scanStart || createTime >= scanEnd) continue
      const prev = first.get(c.issueUuid)
      if (prev === undefined || createTime < prev) {
        first.set(c.issueUuid, createTime)
      }
    }
    return first
  }

  /**
   * 终态判定（T13）：changelog 的 old/new value 是状态选项 uuid 或名称，
   * OpenAPI 不返回 category。约定：值包含 'done'/'完成'/'关闭'/'resolved' 视为终态。
   */
  private isToDone(value: string | null, fieldType: string): boolean {
    if (!value || fieldType !== 'status') return false
    return /done|完成|关闭|resolved|closed|finished/i.test(value)
  }
}
