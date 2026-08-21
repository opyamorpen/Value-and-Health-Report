import { MetricsService } from '../services/metrics.service'
import { compareValues } from '../types'
import type {
  CollectedChangeRecord,
  CollectedEstimate,
  CollectedIssue,
  CollectedIssueType,
  CollectedProject,
  CollectedSprint,
  CollectedSpent,
  CollectResult,
} from '../services/collectors.service'

/**
 * v0.2 单测（docs/value-standard.md）：
 * 双周期环比、趋势标签阈值、类型拆分、价值亮点、机器人过滤、时区边界、样本不足。
 */

const DAY = 86400000
// 周期：2026-05-23 ~ 2026-08-21（90 天）；对比：2026-02-22 ~ 2026-05-23
const period = {
  start: Date.UTC(2026, 4, 23),
  end: Date.UTC(2026, 7, 21),
  compareStart: Date.UTC(2026, 1, 22),
  compareEnd: Date.UTC(2026, 4, 23),
}

const service = new MetricsService()

const ok = <T,>(data: T, errors: string[] = []): CollectResult<T> => ({ data, errors })

const project = (over: Partial<CollectedProject> = {}): CollectedProject => ({
  uuid: 'proj1',
  name: '项目',
  createTime: period.start,
  status: 'in_progress',
  statusCategory: 'in_progress',
  isArchive: false,
  ...over,
})

const issueType = (over: Partial<CollectedIssueType> = {}): CollectedIssueType => ({
  uuid: 'type-req',
  name: '需求',
  isSub: false,
  ...over,
})

const issue = (over: Partial<CollectedIssue> = {}): CollectedIssue => ({
  uuid: 'issue1',
  title: '工作项',
  createTime: period.start + DAY,
  statusCategory: 'to_do',
  dueDate: null,
  projectUuid: 'proj1',
  ...over,
})

const change = (over: Partial<CollectedChangeRecord> = {}): CollectedChangeRecord => ({
  issueUuid: 'issue1',
  versionUuid: 'v1',
  createTime: period.start + 2 * DAY,
  fieldUuid: 'field005',
  fieldName: '状态',
  fieldType: 'status',
  oldValue: 'todo-status',
  newValue: 'done-status',
  authorUuid: 'user1',
  authorName: '张三',
  isBot: false,
  ...over,
})

/** 组装 bundle 的便捷工厂 */
const bundle = (over: Partial<Parameters<MetricsService['compute']>[1]> = {}) => ({
  projects: ok<CollectedProject[]>([project()]),
  sprints: ok<CollectedSprint[]>([]),
  issueTypes: ok<CollectedIssueType[]>([]),
  issues: ok<CollectedIssue[]>([]),
  changelogs: ok<CollectedChangeRecord[]>([]),
  estimates: ok<CollectedEstimate[]>([]),
  spent: ok<CollectedSpent[]>([]),
  wikiSpaceCount: ok<number>(0),
  ...over,
})

describe('compareValues（value-standard §2.3 趋势阈值）', () => {
  it('数值类：|Δ%|≥10% 显著、5~10% 略有、<5% 持平', () => {
    expect(compareValues('up', 120, 100, 'count', 10).trendLabel).toBe('显著提升')
    expect(compareValues('up', 106, 100, 'count', 10).trendLabel).toBe('略有提升')
    expect(compareValues('up', 103, 100, 'count', 10).trendLabel).toBe('基本持平')
    expect(compareValues('up', 80, 100, 'count', 10).trendLabel).toBe('显著下降')
  })

  it('比率类：按百分点差判定', () => {
    expect(compareValues('up', 0.92, 0.85, 'ratio', 10).trendLabel).toBe('显著提升')
    expect(compareValues('up', 0.88, 0.85, 'ratio', 10).trendLabel).toBe('略有提升')
    expect(compareValues('up', 0.86, 0.85, 'ratio', 10).trendLabel).toBe('基本持平')
  })

  it('direction 决定改善解读：交付周期下降=改善', () => {
    const faster = compareValues('down', 72, 96, 'count', 10)
    expect(faster.trendLabel).toBe('显著下降')
    expect(faster.isImprovement).toBe(true)
    const slower = compareValues('down', 120, 96, 'count', 10)
    expect(slower.isImprovement).toBe(false)
  })

  it('previous=0 且 current>0 → 新增；样本不足 → 未知', () => {
    expect(compareValues('up', 5, 0, 'count', 10).trendLabel).toBe('新增')
    expect(compareValues('up', 5, 0, 'count', 10).isImprovement).toBe(true)
    const unknown = compareValues('up', 120, 100, 'count', 3)
    expect(unknown.trendLabel).toBe('未知')
    expect(unknown.isImprovement).toBeNull()
  })

  it('样本足够但 current/previous 为 null → 未知', () => {
    expect(compareValues('up', null, 100, 'count', 10).trendLabel).toBe('未知')
  })
})

describe('MetricsService.compute（v0.2 双周期）', () => {
  it('环比：当前周期与对比周期各算一遍，形成 delta', () => {
    const issues: CollectedIssue[] = []
    const changes: CollectedChangeRecord[] = []
    // 当前周期 6 个创建，对比周期 3 个
    for (let i = 0; i < 6; i++) {
      issues.push(issue({ uuid: `cur${i}`, createTime: period.start + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `cur${i}`, createTime: period.start + (i + 1) * DAY }))
    }
    for (let i = 0; i < 3; i++) {
      issues.push(issue({ uuid: `prev${i}`, createTime: period.compareStart + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `prev${i}`, createTime: period.compareStart + (i + 1) * DAY }))
    }
    const report = service.compute(period, bundle({
      issueTypes: ok([issueType()]),
      issues: ok(issues),
      changelogs: ok(changes),
    }), 1000)
    expect(report.requirement.created.current).toBe(6)
    expect(report.requirement.created.previous).toBe(3)
    expect(report.requirement.created.delta).toBe(3)
    expect(report.requirement.created.trendLabel).toBe('显著提升')
    expect(report.requirement.created.isImprovement).toBe(true)
  })

  it('类型拆分：需求/缺陷按 issueTypes 映射，未分类降级', () => {
    const issues = [
      issue({ uuid: 'r1', createTime: period.start + DAY, issueTypeUuid: 'type-req' }),
      issue({ uuid: 'd1', createTime: period.start + DAY, issueTypeUuid: 'type-bug' }),
      issue({ uuid: 'd2', createTime: period.start + 2 * DAY, issueTypeUuid: 'type-bug' }),
    ]
    const report = service.compute(period, bundle({
      issueTypes: ok([
        issueType({ uuid: 'type-req', name: '需求' }),
        issueType({ uuid: 'type-bug', name: '缺陷' }),
      ]),
      issues: ok(issues),
    }), 1000)
    expect(report.requirement.typeSplit).toBe(true)
    expect(report.defect.typeSplit).toBe(true)
    expect(report.requirement.created.current).toBe(1)
    expect(report.defect.found.current).toBe(2)
  })

  it('类型映射缺失 → typeSplit=false，缺陷维度降级未知', () => {
    const report = service.compute(period, bundle({
      issueTypes: ok([]),
      issues: ok([issue({ createTime: period.start + DAY })]),
    }), 1000)
    expect(report.requirement.typeSplit).toBe(false)
    expect(report.defect.typeSplit).toBe(false)
    expect(report.defect.found.trendLabel).toBe('未知')
  })

  it('首次完成取最早终态记录；周期外完成不计入当前周期', () => {
    const issues = [
      issue({ uuid: 'a', createTime: period.start + DAY, issueTypeUuid: 'type-req' }),
      issue({ uuid: 'b', createTime: period.start + DAY, issueTypeUuid: 'type-req' }),
    ]
    const changes = [
      change({ issueUuid: 'a', createTime: period.start + 2 * DAY }),
      change({ issueUuid: 'a', createTime: period.start + 30 * DAY }),
      // b 完成时间在对比周期 → 不计入当前周期交付
      change({ issueUuid: 'b', createTime: period.compareStart + DAY }),
    ]
    const report = service.compute(period, bundle({
      issueTypes: ok([issueType()]),
      issues: ok(issues),
      changelogs: ok(changes),
    }), 1000)
    expect(report.requirement.delivered.current).toBe(1)
  })

  it('价值亮点：显著改善进入亮点，按幅度排序', () => {
    const issues: CollectedIssue[] = []
    const changes: CollectedChangeRecord[] = []
    // 当前周期 12 个需求全交付，对比周期 5 个 → 交付量 +140%（显著）
    for (let i = 0; i < 12; i++) {
      issues.push(issue({ uuid: `c${i}`, createTime: period.start + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `c${i}`, createTime: period.start + i * DAY + 3600000 }))
    }
    for (let i = 0; i < 5; i++) {
      issues.push(issue({ uuid: `p${i}`, createTime: period.compareStart + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `p${i}`, createTime: period.compareStart + i * DAY + 3600000 }))
    }
    const report = service.compute(period, bundle({
      issueTypes: ok([issueType()]),
      issues: ok(issues),
      changelogs: ok(changes),
    }), 1000)
    expect(report.highlights.length).toBeGreaterThan(0)
    expect(report.highlights.some(h => h.metric === 'requirement.delivered' && h.kind === 'improvement')).toBe(true)
    expect(report.highlights[0].text).toContain('需求交付量')
  })

  it('无显著改善时回退为绝对成果，不硬凑', () => {
    // 两周期数据完全一致 → 无 delta → 回退成果句
    const issues: CollectedIssue[] = []
    const changes: CollectedChangeRecord[] = []
    for (let i = 0; i < 6; i++) {
      issues.push(issue({ uuid: `c${i}`, createTime: period.start + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `c${i}`, createTime: period.start + i * DAY + 3600000 }))
      issues.push(issue({ uuid: `p${i}`, createTime: period.compareStart + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `p${i}`, createTime: period.compareStart + i * DAY + 3600000 }))
    }
    const report = service.compute(period, bundle({
      issueTypes: ok([issueType()]),
      issues: ok(issues),
      changelogs: ok(changes),
    }), 1000)
    expect(report.highlights.every(h => h.kind === 'achievement')).toBe(true)
  })

  it('显著退步进入需关注（中性措辞，最多 2 条）', () => {
    const issues: CollectedIssue[] = []
    const changes: CollectedChangeRecord[] = []
    // 当前周期 6 个需求交付，对比周期 20 个 → -70%（显著退步；样本量按当前周期 6 ≥ Q）
    for (let i = 0; i < 6; i++) {
      issues.push(issue({ uuid: `c${i}`, createTime: period.start + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `c${i}`, createTime: period.start + i * DAY + 3600000 }))
    }
    for (let i = 0; i < 20; i++) {
      issues.push(issue({ uuid: `p${i}`, createTime: period.compareStart + i * DAY, issueTypeUuid: 'type-req' }))
      changes.push(change({ issueUuid: `p${i}`, createTime: period.compareStart + i * DAY + 3600000 }))
    }
    const report = service.compute(period, bundle({
      issueTypes: ok([issueType()]),
      issues: ok(issues),
      changelogs: ok(changes),
    }), 1000)
    expect(report.concerns.length).toBeGreaterThan(0)
    expect(report.concerns[0].text).toContain('建议关注')
  })

  it('协作：机器人过滤 + 双周期参与人数', () => {
    const changes = [
      change({ authorUuid: 'u1', authorName: '张三', createTime: period.start + DAY }),
      // 机器人不计
      change({ authorUuid: 'bot1', authorName: '{{system_bot}}', createTime: period.start + DAY }),
      // 创建者字段不计
      change({ authorUuid: 'u2', authorName: '李四', fieldUuid: 'field003', createTime: period.start + DAY }),
      // 对比周期的行为
      change({ authorUuid: 'u3', authorName: '王五', createTime: period.compareStart + DAY }),
    ]
    const report = service.compute(period, bundle({ changelogs: ok(changes) }), 1000)
    expect(report.collaboration.participants.current).toBe(1)
    expect(report.collaboration.participants.previous).toBe(1)
    expect(report.collaboration.manualActions.current).toBe(1)
  })

  it('交付周期 P50：样本<Q 显示未知；down 方向下降=改善', () => {
    const issues: CollectedIssue[] = []
    const changes: CollectedChangeRecord[] = []
    for (let i = 0; i < 6; i++) {
      issues.push(issue({ uuid: `i${i}`, createTime: period.start + i * DAY }))
      changes.push(change({ issueUuid: `i${i}`, createTime: period.start + i * DAY + 48 * 3600000 }))
    }
    const report = service.compute(period, bundle({
      issues: ok(issues),
      changelogs: ok(changes),
    }), 1000)
    expect(report.deliveryEfficiency.cycleP50Hours.current).toBe(48)
    expect(report.deliveryEfficiency.cycleP50Hours.direction).toBe('down')
  })

  it('时区边界：start 含 end 不含', () => {
    const report = service.compute(period, bundle({
      issues: ok([
        issue({ uuid: 'at-start', createTime: period.start }),
        issue({ uuid: 'at-end', createTime: period.end }),
      ]),
    }), 1000)
    expect(report.requirement.created.current).toBe(1)
  })

  it('活跃项目：按 projectUuid 归并（v0.1 口径修正——不再把 issueUuid 计入）', () => {
    // proj1 下 1 个 issue；proj2 无 issue。活跃项目应为 1（若按 v0.1 bug 会算 2）
    const report = service.compute(period, bundle({
      projects: ok([project(), project({ uuid: 'proj2' })]),
      issues: ok([issue({ createTime: period.start + DAY })]),
      changelogs: ok([change({ createTime: period.start + 2 * DAY })]),
    }), 1000)
    expect(report.scope.activeProjects.current).toBe(1)
  })

  it('Sprint 终态（§4.2 修正）：status 关键词或 finishTime 存在', () => {
    const sprints = [
      // status 终态 + 完成时间在周期内 → 计入
      { uuid: 's1', name: '迭代1', status: 'done', startDate: period.start, endDate: period.start + 14 * DAY, finishTime: period.start + 14 * DAY },
      // 非终态 → 不计入
      { uuid: 's2', name: '迭代2', status: 'in_progress', startDate: period.start, endDate: period.start + 14 * DAY },
    ] as CollectedSprint[]
    const report = service.compute(period, bundle({ sprints: ok(sprints) }), 1000)
    expect(report.sprintExecution.finished.current).toBe(1)
  })

  it('知识沉淀：field048 关联计数与占比', () => {
    const issues = [
      issue({ uuid: 'w1', createTime: period.start + DAY, wikiLinked: true }),
      issue({ uuid: 'w2', createTime: period.start + DAY }),
      issue({ uuid: 'w3', createTime: period.start + DAY, wikiLinked: true }),
      issue({ uuid: 'w4', createTime: period.start + DAY }),
      issue({ uuid: 'w5', createTime: period.start + DAY, wikiLinked: true }),
      // 对比周期 5 个无关联
      ...Array.from({ length: 5 }, (_, i) =>
        issue({ uuid: `pw${i}`, createTime: period.compareStart + i * DAY }),
      ),
    ]
    const report = service.compute(period, bundle({
      issues: ok(issues),
      wikiSpaceCount: ok(3),
    }), 1000)
    expect(report.knowledge.wikiLinkedCount.current).toBe(3)
    expect(report.knowledge.wikiLinkedRate.current).toBe(0.6)
    expect(report.knowledge.wikiSpaces).toBe(3)
  })

  it('管理规范度：负责人/截止日期填写率', () => {
    const issues = [
      issue({ uuid: 'f1', createTime: period.start + DAY, assigneeUuid: 'u1', dueDate: '2026-08-01' }),
      issue({ uuid: 'f2', createTime: period.start + DAY, assigneeUuid: 'u1' }),
      issue({ uuid: 'f3', createTime: period.start + DAY }),
      issue({ uuid: 'f4', createTime: period.start + Day2(), dueDate: '2026-08-01' }),
      issue({ uuid: 'f5', createTime: period.start + Day2(), assigneeUuid: 'u2', dueDate: '2026-08-01' }),
      // 对比周期全空
      ...Array.from({ length: 5 }, (_, i) =>
        issue({ uuid: `pf${i}`, createTime: period.compareStart + i * DAY }),
      ),
    ]
    const report = service.compute(period, bundle({ issues: ok(issues) }), 1000)
    expect(report.discipline.assigneeFillRate.current).toBe(0.6)
    expect(report.discipline.dueDateFillRate.current).toBe(0.6)
  })

  it('工时实践：预估/登记覆盖率与准确度', () => {
    const issues = [
      issue({ uuid: 't1', createTime: period.start + DAY, timeEstimated: 8 }),
      issue({ uuid: 't2', createTime: period.start + DAY, timeEstimated: 4 }),
      issue({ uuid: 't3', createTime: period.start + DAY }),
      issue({ uuid: 't4', createTime: period.start + DAY, timeEstimated: 8 }),
      issue({ uuid: 't5', createTime: period.start + DAY, timeEstimated: 2 }),
      // 凑齐 5 个配对样本（准确度中位数要求 ≥ Q）
      issue({ uuid: 't6', createTime: period.start + DAY, timeEstimated: 6 }),
    ]
    const estimates = [
      { issueUuid: 't1', seconds: 8 * 3600 },
      { issueUuid: 't2', seconds: 4 * 3600 },
      { issueUuid: 't4', seconds: 8 * 3600 },
      { issueUuid: 't5', seconds: 2 * 3600 },
      { issueUuid: 't6', seconds: 6 * 3600 },
    ]
    const spent = [
      { issueUuid: 't1', seconds: 10 * 3600, records: 1 }, // |10-8|/8 = 0.25
      { issueUuid: 't2', seconds: 5 * 3600, records: 1 }, // |5-4|/4 = 0.25
      { issueUuid: 't4', seconds: 8 * 3600, records: 1 }, // 0
      { issueUuid: 't5', seconds: 3 * 3600, records: 1 }, // |3-2|/2 = 0.5
      { issueUuid: 't6', seconds: 6 * 3600, records: 1 }, // 0
    ]
    const report = service.compute(period, bundle({
      issues: ok(issues),
      estimates: ok(estimates),
      spent: ok(spent),
    }), 1000)
    // 6 个创建中 5 个有预估
    expect(report.worklogPractice.estimateCoverage.current).toBeCloseTo(5 / 6, 2)
    // 偏差样本 [0.25, 0.25, 0, 0.5, 0] 排序后 [0, 0, 0.25, 0.25, 0.5] → 中位数 0.25
    expect(report.worklogPractice.estimateAccuracyMedian).toBe(0.25)
    expect(report.worklogPractice.pairedSampleSize).toBe(5)
  })

  it('信封：所有维度携带 ruleVersion 与 collectedAt', () => {
    const report = service.compute(period, bundle({
      issues: ok([issue()]),
      changelogs: ok([change()]),
    }), 1000)
    const envelopes = [
      report.scope,
      report.requirement,
      report.defect,
      report.sprintExecution,
      report.deliveryEfficiency,
      report.collaboration,
      report.discipline,
      report.worklogPractice,
      report.knowledge,
    ]
    for (const envelope of envelopes) {
      expect(envelope.ruleVersion).toBe('value-standard-v0.2')
      expect(envelope.source).toBeTruthy()
      expect(envelope.collectedAt).toBe(1000)
    }
  })
})

function Day2(): number {
  return 2 * DAY
}
