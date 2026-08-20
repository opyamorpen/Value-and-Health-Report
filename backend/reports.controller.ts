import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { JobsService } from './services/jobs.service'
import { ReportsService } from './services/reports.service'
import { AuditService } from './services/audit.service'
import { PdfService } from './services/pdf.service'
import type { Period } from './types'

/**
 * 报告 API（README「应用接口」）：
 * POST /api/report-jobs、GET /api/report-jobs/{id}、GET /api/reports/{id}、
 * PATCH /api/reports/{id}/narrative、GET /api/reports/{id}/evidence
 * （exports 端点在 M3 后半随 PDF 一并交付）
 * 身份：M3 骨架阶段从 query 传入团队（与 ONES.getTeamInfo 对齐），白名单鉴权随后引入。
 */
@Controller('api')
export class ReportsApiController {
  constructor(
    private readonly jobs: JobsService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
  ) {}

  /** 创建报告任务：当前团队 + 日期范围（默认近 90 天 vs 前 90 天） */
  @Post('report-jobs')
  async createJob(
    @Body() body: { teamID?: string; userID?: string; periodStart?: number; periodEnd?: number },
    @Res({ passthrough: true }) res: Response,
  ) {
    const teamUuid = (body.teamID || '').trim()
    if (!teamUuid) {
      res.status(400)
      return { ok: false, error: 'teamID required' }
    }
    const now = Date.now()
    const periodEnd = body.periodEnd ?? now
    const periodStart = body.periodStart ?? periodEnd - 90 * 86400000
    if (periodStart >= periodEnd) {
      res.status(400)
      return { ok: false, error: 'periodStart must be before periodEnd' }
    }
    const span = periodEnd - periodStart
    const period: Period = {
      start: periodStart,
      end: periodEnd,
      compareStart: periodStart - span,
      compareEnd: periodStart,
    }
    const job = await this.jobs.createJob(teamUuid, period, body.userID || '', async (action, targetType, targetId, detail) => {
      await this.audit.record(teamUuid, body.userID || '', action, targetType, targetId, detail)
    })
    return { ok: true, job }
  }

  @Get('report-jobs/:jobId')
  async getJob(@Param('jobId') jobId: string, @Res({ passthrough: true }) res: Response) {
    const job = await this.jobs.getJob(jobId)
    if (!job) {
      res.status(404)
      return { ok: false, error: 'job not found' }
    }
    return { ok: true, job }
  }

  @Get('reports/:snapshotId')
  async getReport(@Param('snapshotId') snapshotId: string, @Res({ passthrough: true }) res: Response) {
    const snapshot = await this.reports.getSnapshot(snapshotId)
    if (!snapshot) {
      res.status(404)
      return { ok: false, error: 'report not found' }
    }
    return { ok: true, report: snapshot }
  }

  @Patch('reports/:snapshotId/narrative')
  async saveNarrative(
    @Param('snapshotId') snapshotId: string,
    @Body() body: { userID?: string; narrative?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.narrative || typeof body.narrative !== 'object') {
      res.status(400)
      return { ok: false, error: 'narrative object required' }
    }
    const result = await this.reports.saveNarrative(snapshotId, body.userID || '', body.narrative)
    if (!result.ok) {
      res.status(404)
      return result
    }
    return result
  }

  @Get('reports/:snapshotId/evidence')
  async getEvidence(@Param('snapshotId') snapshotId: string, @Res({ passthrough: true }) res: Response) {
    const evidence = await this.reports.getEvidence(snapshotId)
    if (!evidence) {
      res.status(404)
      return { ok: false, error: 'report not found' }
    }
    return { ok: true, evidence }
  }

  /** 导出客户版 PDF：按确认板块生成（价值亮点/健康度/机会/附录），返回下载 URL（1h 有效） */
  @Post('reports/:snapshotId/exports')
  async exportPdf(
    @Param('snapshotId') snapshotId: string,
    @Body() body: { userID?: string; sections?: { valueHighlights?: boolean; healthMatrix?: boolean; opportunities?: boolean; appendix?: boolean } },
    @Res({ passthrough: true }) res: Response,
  ) {
    const snapshot = await this.reports.getSnapshot(snapshotId)
    if (!snapshot) {
      res.status(404)
      return { ok: false, error: 'report not found' }
    }
    try {
      const result = await this.pdf.generatePdf(
        {
          snapshotId: snapshot.snapshotId,
          teamUuid: snapshot.teamUuid,
          period: snapshot.period,
          ruleVersion: snapshot.ruleVersion,
          coverage: snapshot.coverage,
          metrics: (snapshot.metrics as Record<string, never>) as never,
          narrative: snapshot.narrative,
        },
        body.sections ?? { valueHighlights: true },
        body.userID ?? '',
      )
      return { ok: true, export: result }
    } catch (error) {
      res.status(500)
      return { ok: false, error: String((error as Error).message).slice(0, 200) }
    }
  }

  @Get('snapshots')
  async listSnapshots(@Query('teamID') teamUuid: string) {
    return { ok: true, snapshots: await this.reports.listSnapshots(teamUuid) }
  }
}
