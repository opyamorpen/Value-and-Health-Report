import { MetricsService } from '../services/metrics.service'
import type { CollectedChangeRecord, CollectedIssue, CollectedProject, CollectedSprint, CollectResult } from '../services/collectors.service'

/**
 * M5 固定数据单测（README 实施步骤 4）：
 * 跨周期统计、首次完成、重开、终态 Sprint、机器人过滤、时区边界、缺失值、样本不足。
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

const okProjects = (data: CollectedProject[], errors: string[] = []): CollectResult<CollectedProject[]> => ({ data, errors })
const okSprints = (data: CollectedSprint[], errors: string[] = []): CollectResult<CollectedSprint[]> => ({ data, errors })
const okIssues = (data: CollectedIssue[], errors: string[] = []): CollectResult<CollectedIssue[]> => ({ data, errors })
const okChanges = (data: CollectedChangeRecord[], errors: string[] = []): CollectResult<CollectedChangeRecord[]> => ({ data, errors })

const project = (over: Partial<CollectedProject> = {}): CollectedProject => ({
  uuid: 'proj1',
  name: '项目',
  createTime: period.start,
  status: 'in_progress',
  statusCategory: 'in_progress',
  isArchive: false,
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

describe('MetricsService.compute', () => {
  describe('项目指标', () => {
    it('归档项目不计入状态分布；周期内新建项目正确统计', () => {
      const report = service.compute(period, {
        projects: okProjects([
          project({ createTime: period.start + DAY }),
          project({ uuid: 'p2', createTime: period.compareStart + DAY }),
          project({ uuid: 'p3', createTime: period.start, isArchive: true }),
        ]),
        sprints: okSprints([]),
        issues: okIssues([]),
        changelogs: okChanges([]),
      }, 1000)
      expect(report.projects.newProjects).toBe(2) // 周期内（p3 也在周期起点但归档不计）
      expect(report.projects.statusDistribution).toEqual({ in_progress: 2 })
      expect(report.projects.status).toBe('ok')
    })

    it('无项目时状态为 unknown', () => {
      const report = service.compute(period, {
        projects: okProjects([]),
        sprints: okSprints([]),
        issues: okIssues([]),
        changelogs: okChanges([]),
      }, 1000)
      expect(report.projects.status).toBe('unknown')
    })
  })

  describe('工作项：首次完成与重开', () => {
    it('首次完成取最早终态记录；周期外完成不计入当前周期', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([
          issue({ uuid: 'a', createTime: period.start + DAY }),
          issue({ uuid: 'b', createTime: period.start + DAY }),
        ]),
        changelogs: okChanges([
          // a：周期内两次进入终态 → 首完取第一次
          change({ issueUuid: 'a', createTime: period.start + 2 * DAY }),
          change({ issueUuid: 'a', createTime: period.start + 30 * DAY }),
          // b：完成时间在对比周期 → 不计入当前周期首完
          change({ issueUuid: 'b', createTime: period.compareStart + DAY }),
        ]),
      }, 1000)
      expect(report.issues.firstCompleted).toBe(1)
    })

    it('重开：终态→非终态的变更计一次；同一记录双向只计重开方向', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([issue()]),
        changelogs: okChanges([
          // 完成
          change({ createTime: period.start + DAY, oldValue: 'todo', newValue: 'done' }),
          // 重开（done → todo）
          change({ createTime: period.start + 2 * DAY, oldValue: 'done', newValue: 'todo' }),
          // 再次完成（todo → done，非重开）
          change({ createTime: period.start + 3 * DAY, oldValue: 'todo', newValue: 'done' }),
        ]),
      }, 1000)
      expect(report.issues.reopened).toBe(1)
    })

    it('吞吐量周趋势：创建与完成按 ISO 周聚合', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([issue({ createTime: period.start + DAY })]),
        changelogs: okChanges([change({ createTime: period.start + 2 * DAY })]),
      }, 1000)
      expect(report.issues.throughputTrend.length).toBeGreaterThan(0)
      const totalCompleted = report.issues.throughputTrend.reduce((s, w) => s + w.completed, 0)
      expect(totalCompleted).toBe(1)
    })
  })

  describe('交付周期 P50/P75', () => {
    it('样本不足（<5）时显示未知', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([issue()]),
        changelogs: okChanges([change()]),
      }, 1000)
      expect(report.cycleTime.status).toBe('unknown')
      expect(report.cycleTime.p50Hours).toBeNull()
      expect(report.cycleTime.sampleSize).toBe(1)
    })

    it('样本充足时 P50 ≤ P75 且按创建→首次完成计算', () => {
      const issues: CollectedIssue[] = []
      const changes: CollectedChangeRecord[] = []
      for (let i = 0; i < 6; i++) {
        const uuid = `issue${i}`
        issues.push(issue({ uuid, createTime: period.start + i * DAY }))
        changes.push(change({ issueUuid: uuid, createTime: period.start + (i + 2) * DAY }))
      }
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues(issues),
        changelogs: okChanges(changes),
      }, 1000)
      expect(report.cycleTime.status).toBe('ok')
      expect(report.cycleTime.sampleSize).toBe(6)
      expect(report.cycleTime.p50Hours).toBe(48)
      expect(report.cycleTime.p75Hours).toBeGreaterThanOrEqual(report.cycleTime.p50Hours!)
    })
  })

  describe('协作：机器人过滤', () => {
    it('机器人变更不计入人工协作；参与人数去重', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([issue()]),
        changelogs: okChanges([
          change({ authorUuid: 'u1', authorName: '张三', createTime: period.start + DAY }),
          change({ authorUuid: 'u1', authorName: '张三', fieldUuid: 'field002', createTime: period.start + 2 * DAY }),
          // 机器人（系统名）不计
          change({ authorUuid: 'bot1', authorName: '{{system_bot}}', createTime: period.start + DAY }),
          change({ authorUuid: 'bot2', authorName: '系统', createTime: period.start + DAY }),
          // 创建者字段（field003）不计
          change({ authorUuid: 'u2', authorName: '李四', fieldUuid: 'field003', createTime: period.start + DAY }),
        ]),
      }, 1000)
      expect(report.collaboration.manualFieldChanges).toBe(2)
      expect(report.collaboration.participants).toBe(1)
    })
  })

  describe('计划兑现率', () => {
    it('仅有截止日期且周期内完成的工作项计入', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([
          // 按期：截止在完成之后
          issue({ uuid: 'on-time', dueDate: new Date(period.start + 5 * DAY).toISOString() }),
          // 逾期：完成超过截止 2 天（超出 1 天容差）
          issue({ uuid: 'late', dueDate: new Date(period.start + 1 * DAY).toISOString() }),
          // 无截止日期不计入
          issue({ uuid: 'no-due', dueDate: null }),
        ]),
        changelogs: okChanges([
          change({ issueUuid: 'on-time', createTime: period.start + 2 * DAY }),
          change({ issueUuid: 'late', createTime: period.start + 4 * DAY }),
          change({ issueUuid: 'no-due', createTime: period.start + 2 * DAY }),
        ]),
      }, 1000)
      expect(report.planFulfillment.total).toBe(2)
      expect(report.planFulfillment.onTime).toBe(1)
      // 样本量 2 < Q(5)：显示未知而非推断比率
      expect(report.planFulfillment.rate).toBeNull()
    })

    it('样本不足时比率为 null', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([issue({ dueDate: new Date(period.start + 5 * DAY).toISOString() })]),
        changelogs: okChanges([change()]),
      }, 1000)
      expect(report.planFulfillment.rate).toBeNull()
    })
  })

  describe('时区边界', () => {
    it('UTC 边界时间（周期起止时刻）正确归属：start 含 end 不含', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([
          issue({ uuid: 'at-start', createTime: period.start }), // 恰好 start → 计入
          issue({ uuid: 'at-end', createTime: period.end }), // 恰好 end → 不计入
        ]),
        changelogs: okChanges([]),
      }, 1000)
      expect(report.issues.created).toBe(1)
    })
  })

  describe('信封与规则版本', () => {
    it('所有指标携带 ruleVersion 与 coverage', () => {
      const report = service.compute(period, {
        projects: okProjects([project()]),
        sprints: okSprints([]),
        issues: okIssues([issue()]),
        changelogs: okChanges([change()]),
      }, 1000)
      for (const envelope of [report.projects, report.sprints, report.issues, report.cycleTime, report.collaboration, report.planFulfillment]) {
        expect(envelope.ruleVersion).toBe('health-standard-v0.1')
        expect(envelope.source).toBeTruthy()
        expect(envelope.collectedAt).toBe(1000)
      }
    })
  })
})
