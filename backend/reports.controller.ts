import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards, Put, Delete } from '@nestjs/common'
import type { Response } from 'express'
import { JobsService } from './services/jobs.service'
import { ReportsService } from './services/reports.service'
import { AuditService } from './services/audit.service'
import { WhitelistGuard, WhitelistService } from './services/whitelist.service'
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
@UseGuards(WhitelistGuard)
export class ReportsApiController {
  constructor(
    private readonly jobs: JobsService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
    private readonly whitelist: WhitelistService,
  ) {}

  /** 白名单管理（仅白名单内 admin 角色可操作） */
  @Get('whitelist')
  async listWhitelist(@Query('teamID') teamUuid: string, @Query('userID') userUuid: string, @Res({ passthrough: true }) res: Response) {
    if (!(await this.isAdmin(teamUuid, userUuid))) {
      res.status(403)
      return { ok: false, error: '仅白名单管理员可查看' }
    }
    return { ok: true, whitelist: await this.whitelist.list(teamUuid) }
  }

  @Put('whitelist')
  async addWhitelist(
    @Body() body: { teamID: string; userID: string; targetUserID: string; role?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!(await this.isAdmin(body.teamID, body.userID))) {
      res.status(403)
      return { ok: false, error: '仅白名单管理员可修改' }
    }
    if (!body.targetUserID) {
      res.status(400)
      return { ok: false, error: 'targetUserID required' }
    }
    try {
      await this.whitelist.add(body.teamID, body.targetUserID, body.role || 'member', body.userID)
      await this.audit.record(body.teamID, body.userID, 'whitelist_updated', 'permission_whitelist', body.targetUserID, { action: 'add' })
      return { ok: true }
    } catch (error) {
      res.status(400)
      return { ok: false, error: String((error as Error).message).slice(0, 150) }
    }
  }

  @Delete('whitelist')
  async removeWhitelist(
    @Query('teamID') teamUuid: string,
    @Query('userID') userUuid: string,
    @Query('targetUserID') targetUserID: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!(await this.isAdmin(teamUuid, userUuid))) {
      res.status(403)
      return { ok: false, error: '仅白名单管理员可修改' }
    }
    await this.whitelist.remove(teamUuid, targetUserID)
    await this.audit.record(teamUuid, userUuid, 'whitelist_updated', 'permission_whitelist', targetUserID, { action: 'remove' })
    return { ok: true }
  }

  private async isAdmin(teamUuid: string, userUuid: string): Promise<boolean> {
    const list = await this.whitelist.list(teamUuid)
    const self = list.find(w => w.userUuid === userUuid)
    return self?.role === 'admin'
  }

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
