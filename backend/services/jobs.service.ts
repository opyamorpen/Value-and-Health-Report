import { Injectable, Logger } from '@nestjs/common'
import { storage } from '@ones-open/node-sdk'
import { randomUUID } from 'node:crypto'

/** entity key 仅允许 [_a-z0-9]{1,64} */
const toKey = (id: string): string => id.replace(/-/g, '_')
import { CollectorsService } from './collectors.service'
import { MetricsService } from './metrics.service'
import { DetectorsService, buildOpportunities } from './detectors.service'
import { RULE_VERSION } from '../types'
import type { AuditAction, JobStage, JobStatus, Period, ReportJob, ReportSnapshot } from '../types'

type ReportJobEntity = {
  job_id: string
  team_uuid: string
  period_start: number
  period_end: number
  compare_start: number
  compare_end: number
  rule_version: string
  status: string
  stage: string
  progress: number
  error: string
  snapshot_key: string
  requested_by: string
  created_at: number
  updated_at: number
}

type SnapshotEntity = {
  snapshot_id: string
  job_id: string
  team_uuid: string
  period_start: number
  period_end: number
  rule_version: string
  metrics_json: string
  narrative_json: string
  coverage: number
  created_at: number
}

const jobEntity = storage.entity<ReportJobEntity>('report_job')
const snapshotEntity = storage.entity<SnapshotEntity>('report_snapshot')

/**
 * 报告任务：异步执行、进度更新、局部成功（partial）、失败原因。
 * 同团队 + 周期 + 规则版本去重（返回已有任务）。
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name)
  private readonly running = new Set<string>()

  constructor(
    private readonly collectors: CollectorsService,
    private readonly metrics: MetricsService,
    private readonly detectors: DetectorsService,
  ) {}

  async createJob(teamUuid: string, period: Period, requestedBy: string, audit: (action: AuditAction, targetType: string, targetId: string, detail: Record<string, unknown>) => Promise<void>): Promise<ReportJob> {
    // 去重：同团队同周期同规则版本的未完成任务
    const existing = await this.findActiveJob(teamUuid, period)
    if (existing) {
      return existing
    }
    const now = Date.now()
    const jobId = randomUUID()
    const jobKey = toKey(jobId)
    const job: ReportJob = {
      jobId,
      teamUuid,
      period,
      ruleVersion: RULE_VERSION,
      status: 'pending',
      stage: 'queued',
      progress: 0,
      error: '',
      snapshotKey: '',
      requestedBy,
      createdAt: now,
      updatedAt: now,
    }
    await jobEntity.set(jobKey, this.toJobEntity(job))
    await audit('job_created', 'report_job', jobId, { teamUuid, period })
    // 异步执行（不阻塞请求）
    void this.execute(job)
    return job
  }

  async getJob(jobId: string): Promise<ReportJob | undefined> {
    const row = await jobEntity.get(toKey(jobId))
    return row ? this.fromJobEntity(row) : undefined
  }

  private async findActiveJob(teamUuid: string, period: Period): Promise<ReportJob | undefined> {
    const result = (await jobEntity.query().getMany()) as unknown
    const rows =
      (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<{ key: string; value: ReportJobEntity }>
    return rows
      .map(r => r.value)
      .filter(j => j && j.team_uuid === teamUuid && j.period_start === period.start && j.period_end === period.end && j.rule_version === RULE_VERSION && (j.status === 'pending' || j.status === 'running'))
      .map(j => this.fromJobEntity(j))[0]
  }

  /** 执行任务：采集 → 聚合 → 快照。部分失败记 error 并判 partial。 */
  private async execute(job: ReportJob): Promise<void> {
    if (this.running.has(job.jobId)) return
    this.running.add(job.jobId)
    try {
      await this.updateJob(job.jobId, { status: 'running', stage: 'collecting_projects', progress: 5 })

      const errors: string[] = []
      const collectedAt = Date.now()

      const projects = await this.collectors.collectProjects(job.teamUuid)
      errors.push(...projects.errors)
      await this.updateJob(job.jobId, { stage: 'collecting_sprints', progress: 15 })

      const projectUuids = projects.data.map(p => p.uuid)
      const sprints = await this.collectors.collectSprints(job.teamUuid, projectUuids)
      errors.push(...sprints.errors)
      await this.updateJob(job.jobId, { stage: 'collecting_issue_types', progress: 25 })

      // 工作项类型清单（v0.2 类型拆分；失败不阻塞——降级全类型口径）
      const issueTypes = await this.collectors.collectIssueTypes(job.teamUuid)
      errors.push(...issueTypes.errors)
      await this.updateJob(job.jobId, { stage: 'collecting_issues', progress: 35 })

      const issues = await this.collectors.collectIssues(job.teamUuid, job.period)
      errors.push(...issues.errors)
      await this.updateJob(job.jobId, { stage: 'collecting_changelog', progress: 50 })

      // changelog 只查当前+对比周期内创建的工作项（控制调用量）
      const relevantIssueUuids = issues.data.map(i => i.uuid).slice(0, 900)
      const changelogs = await this.collectors.collectChangelogs(job.teamUuid, relevantIssueUuids)
      errors.push(...changelogs.errors)
      await this.updateJob(job.jobId, { stage: 'collecting_worklog', progress: 62 })

      // v0.2：工时（O-A5 团队级 + O-A6 逐项采样）与 Wiki 空间数
      const estimates = await this.collectors.collectEstimates(job.teamUuid, job.period)
      errors.push(...estimates.errors)
      const spent = await this.collectors.collectSpent(job.teamUuid, relevantIssueUuids, 500)
      errors.push(...spent.errors)
      const wikiSpaceCount = await this.collectors.collectWikiSpaceCount(job.teamUuid)
      errors.push(...wikiSpaceCount.errors)
      await this.updateJob(job.jobId, { stage: 'computing_metrics', progress: 72 })

      // 健康度矩阵：探测器逐维度执行（失败维度自动降级无法核验）
      let healthMatrix
      try {
        const detectorResults = await this.detectors.detectAll({
          teamUuid: job.teamUuid,
          periodStart: job.period.start,
          periodEnd: job.period.end,
        })
        this.logger.log(`healthMatrix: ${detectorResults.length} dimensions, ${detectorResults.filter(r => r.maturity === '无法核验').length} unverifiable`)
        healthMatrix = {
          results: detectorResults.map(r => ({
            dimension: r.dimension,
            maturity: r.maturity,
            reason: r.reason,
            coverage: r.coverage,
            confidence: r.confidence,
            lastCollectedAt: r.lastCollectedAt,
            evidence: r.evidence,
            suggestion: r.suggestion,
          })),
          opportunities: buildOpportunities(detectorResults),
        }
      } catch (error) {
        errors.push(`healthMatrix: ${String((error as Error).message).slice(0, 120)}`)
      }
      await this.updateJob(job.jobId, { stage: 'saving_snapshot', progress: 85 })

      const valueReport = this.metrics.compute(
        job.period,
        { projects, sprints, issueTypes, issues, changelogs, estimates, spent, wikiSpaceCount },
        collectedAt,
      )

      await this.updateJob(job.jobId, { stage: 'saving_snapshot', progress: 90 })

      const snapshot: ReportSnapshot = {
        snapshotId: randomUUID(),
        jobId: job.jobId,
        teamUuid: job.teamUuid,
        period: job.period,
        ruleVersion: job.ruleVersion,
        valueReport,
        healthMatrix:
          healthMatrix ?? {
            results: [],
            opportunities: [],
          },
        collectedAt,
      }
      await snapshotEntity.set(toKey(snapshot.snapshotId), {
        snapshot_id: snapshot.snapshotId,
        job_id: snapshot.jobId,
        team_uuid: snapshot.teamUuid,
        period_start: job.period.start,
        period_end: job.period.end,
        rule_version: job.ruleVersion,
        metrics_json: JSON.stringify({ value: valueReport, health: snapshot.healthMatrix }),
        narrative_json: JSON.stringify(this.defaultNarrative(valueReport)),
        coverage: this.coverageOf(valueReport),
        created_at: collectedAt,
      })

      const status: JobStatus = errors.length ? 'partial' : 'succeeded'
      await this.updateJob(job.jobId, {
        status,
        stage: 'done',
        progress: 100,
        snapshot_key: snapshot.snapshotId,
        error: errors.join('; ').slice(0, 2000),
      })
      this.logger.log(`job ${job.jobId} ${status}: snapshot ${snapshot.snapshotId}${errors.length ? ` errors=${errors.length}` : ''}`)
    } catch (error) {
      this.logger.error(`job ${job.jobId} failed: ${String((error as Error).message).slice(0, 200)}`)
      await this.updateJob(job.jobId, {
        status: 'failed',
        stage: 'done',
        error: String((error as Error).message).slice(0, 2000),
      }).catch(() => undefined)
    } finally {
      this.running.delete(job.jobId)
    }
  }

  private async updateJob(jobId: string, patch: Partial<ReportJobEntity>): Promise<void> {
    const row = await jobEntity.get(toKey(jobId))
    if (!row) return
    await jobEntity.set(toKey(jobId), { ...row, ...patch, updated_at: Date.now() })
  }

  private coverageOf(report: object): number {
    const values = Object.values(report as Record<string, unknown>).filter(
      (v): v is { coverage?: number } => typeof v === 'object' && v !== null && 'coverage' in v,
    )
    if (!values.length) return 0
    return values.reduce((sum, v) => sum + (v.coverage ?? 0), 0) / values.length
  }

  /** 规则模板生成默认叙事（value-standard §6 三段式：成果句 + 改善句 + 参与句） */
  private defaultNarrative(report: unknown): Record<string, string> {
    const r = report as {
      scope?: { activeProjects?: { current?: number | null }; newProjects?: number }
      requirement?: { delivered?: { current?: number | null }; typeSplit?: boolean }
      defect?: { fixed?: { current?: number | null } }
      sprintExecution?: { finished?: { current?: number | null } }
      collaboration?: { participants?: { current?: number | null }; manualActions?: { current?: number | null }; activeWeeks?: number }
      highlights?: Array<{ text: string }>
    }
    const parts: Record<string, string> = {}
    const reqLabel = r.requirement?.typeSplit ? '需求' : '工作项'
    const delivered = r.requirement?.delivered?.current ?? 0
    const parts1: string[] = []
    parts1.push(`本周期 ${r.scope?.activeProjects?.current ?? 0} 个活跃项目中，交付${reqLabel} ${delivered} 个`)
    if (r.defect?.fixed?.current) parts1.push(`修复缺陷 ${r.defect.fixed.current} 个`)
    if (r.sprintExecution?.finished?.current) parts1.push(`完成迭代 ${r.sprintExecution.finished.current} 个`)
    parts.summary = parts1.join('、') + '。'

    const hl = r.highlights ?? []
    if (hl.length) {
      parts.summary += `与上一周期相比，${hl.slice(0, 2).map(h => h.text).join('；')}。`
    } else {
      parts.summary += '核心指标环比基本持平。'
    }

    const p = r.collaboration?.participants?.current ?? 0
    const a = r.collaboration?.manualActions?.current ?? 0
    parts.summary += `${p} 名成员参与了 ${a} 次协作行为，覆盖 ${r.collaboration?.activeWeeks ?? 0} 个自然周。`
    parts.notes = '以上指标由系统按固定口径计算，可编辑本叙事文本；指标本身不可修改。'
    return parts
  }

  private toJobEntity(job: ReportJob): ReportJobEntity {
    return {
      job_id: job.jobId,
      team_uuid: job.teamUuid,
      period_start: job.period.start,
      period_end: job.period.end,
      compare_start: job.period.compareStart,
      compare_end: job.period.compareEnd,
      rule_version: job.ruleVersion,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      error: job.error,
      snapshot_key: job.snapshotKey,
      requested_by: job.requestedBy,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    }
  }

  private fromJobEntity(row: ReportJobEntity): ReportJob {
    return {
      jobId: row.job_id,
      teamUuid: row.team_uuid,
      period: {
        start: row.period_start,
        end: row.period_end,
        compareStart: row.compare_start,
        compareEnd: row.compare_end,
      },
      ruleVersion: row.rule_version,
      status: row.status as JobStatus,
      stage: row.stage as JobStage,
      progress: row.progress,
      error: row.error,
      snapshotKey: row.snapshot_key,
      requestedBy: row.requested_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
