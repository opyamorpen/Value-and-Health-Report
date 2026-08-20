import { Injectable } from '@nestjs/common'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { storage } from '@ones-open/node-sdk'
import type { ObjectStoreUploadResult } from '@ones-open/node-sdk'
import { randomUUID } from 'node:crypto'
import { getPublicPath } from '../utils'
import { AuditService } from './audit.service'

/**
 * 客户版 PDF：确定性服务端模板（pdfkit + CJK 子集字体）。
 * CSM 只能选择导出板块与编辑叙事；指标由快照不可变数据渲染。
 * 客户版默认隐藏：内部接口错误细节、内部销售备注、人员明细。
 */

export type ExportSections = {
  valueHighlights?: boolean
  healthMatrix?: boolean
  opportunities?: boolean
  appendix?: boolean
}

export type ExportResult = {
  exportId: string
  objectKey: string
  downloadUrl: string
  expiresHint: string
}

type PdfReportData = {
  snapshotId: string
  teamUuid: string
  period: { start: number; end: number }
  ruleVersion: string
  coverage: number
  metrics: {
    projects: { newProjects: number; activeProjects: number; statusDistribution: Record<string, number> }
    sprints: { created: number; finished: number; onTimeFinished: number }
    issues: { created: number; firstCompleted: number; reopened: number }
    cycleTime: { p50Hours: number | null; p75Hours: number | null; sampleSize: number }
    collaboration: { manualFieldChanges: number; participants: number }
    planFulfillment: { total: number; onTime: number; rate: number | null }
  }
  narrative: Record<string, string>
}

type ExportRecordEntity = {
  export_id: string
  snapshot_id: string
  team_uuid: string
  requested_by: string
  sections_json: string
  object_key: string
  created_at: number
}

const exportEntity = storage.entity<ExportRecordEntity>('export_record')

const toKey = (id: string): string => id.replace(/-/g, '_')

const PAGE = { width: 595.28, height: 841.89, margin: 48 }

@Injectable()
export class PdfService {
  private fontData: Buffer | undefined

  constructor(private readonly audit: AuditService) {}

  async generatePdf(
    report: PdfReportData,
    sections: ExportSections,
    requestedBy: string,
  ): Promise<ExportResult> {
    // 动态 import 避免 ncc 打包顶层副作用
    const PDFDocument = (await import('pdfkit')).default
    if (!this.fontData) {
      this.fontData = readFileSync(join(getPublicPath(), 'fonts', 'NotoSansCJKsc-Subset.otf'))
    }

    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin })
    doc.registerFont('cjk', this.fontData)
    doc.font('cjk')

    const periodLabel = `${this.fmtDate(report.period.start)} 至 ${this.fmtDate(report.period.end)}`
    const exportId = randomUUID()

    // 封面头部
    doc.fontSize(20).fillColor('#1f2733').text('客户价值与应用健康度报告', { align: 'center' })
    doc.moveDown(0.4)
    doc.fontSize(10).fillColor('#6b7482').text(`统计周期：${periodLabel}`, { align: 'center' })
    doc.fontSize(10).fillColor('#6b7482').text(`生成时间：${this.fmtDateTime(Date.now())}`, { align: 'center' })
    doc.moveDown(1.2)
    this.horizontalRule(doc)

    // 价值摘要（叙事，CSM 已编辑）
    doc.moveDown(0.8)
    doc.fontSize(14).fillColor('#1f2733').text('价值摘要')
    doc.moveDown(0.3)
    doc.fontSize(10.5).fillColor('#333d4d').text(report.narrative?.summary ?? '暂无摘要', { lineGap: 4 })

    if (sections.valueHighlights !== false) {
      this.renderValueHighlights(doc, report)
    }
    if (sections.healthMatrix) {
      this.renderHealthPlaceholder(doc)
    }
    if (sections.opportunities) {
      this.renderOpportunitiesPlaceholder(doc)
    }

    // 口径说明（附录）
    if (sections.appendix !== false) {
      doc.addPage()
      doc.fontSize(14).fillColor('#1f2733').text('口径说明')
      doc.moveDown(0.3)
      doc.fontSize(9.5).fillColor('#4a5568')
        .text('· 所有指标为团队级聚合，不包含任何个人排名或明细。', { lineGap: 3 })
        .text('· 交付周期按「创建 → 首次进入完成状态」计算；样本量不足时显示「未知」。', { lineGap: 3 })
        .text('· 协作统计已过滤系统与自动化账号。', { lineGap: 3 })
        .text(`· 规则版本 ${report.ruleVersion}；证据覆盖率 ${Math.round(report.coverage * 100)}%。`, { lineGap: 3 })
    }

    doc.end()

    // 收集 PDF 字节
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      doc.on('end', () => resolve())
      doc.on('error', reject)
    })
    const pdfBytes = Buffer.concat(chunks)

    // 上传 Object Storage
    const objectKey = `report_${toKey(report.snapshotId)}_${toKey(exportId)}.pdf`
    let upload: Awaited<ReturnType<typeof storage.object.upload>>
    try {
      upload = await storage.object.upload(objectKey)
    } catch (error) {
      throw new Error(`object.upload threw: ${String((error as Error).message ?? error).slice(0, 150)}`)
    }
    if (!(upload instanceof Object) || typeof (upload as ObjectStoreUploadResult).getFields !== 'function') {
      throw new Error(`object upload failed: ${JSON.stringify(upload).slice(0, 150)}`)
    }
    const uploadInfo = upload as ObjectStoreUploadResult
    const form = uploadInfo.getFields()
    const formData = new FormData()
    for (const [key, value] of Object.entries(form)) {
      formData.append(key, String(value))
    }
    formData.append('file', new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }))
    let putResp: Response
    try {
      putResp = await fetch(uploadInfo.getWebUrl(), { method: 'POST', body: formData })
    } catch (error) {
      throw new Error(
        `object upload fetch failed (url=${uploadInfo.getWebUrl().slice(0, 80)}): ${String((error as Error).cause ?? (error as Error).message ?? error).slice(0, 200)}`,
      )
    }
    if (!putResp.ok) {
      throw new Error(`object upload request failed: HTTP ${putResp.status} ${(await putResp.text().catch(() => '')).slice(0, 150)}`)
    }

    // 记录导出
    await exportEntity.set(toKey(exportId), {
      export_id: exportId,
      snapshot_id: report.snapshotId,
      team_uuid: report.teamUuid,
      requested_by: requestedBy,
      sections_json: JSON.stringify(sections),
      object_key: objectKey,
      created_at: Date.now(),
    })
    await this.audit.record(report.teamUuid, requestedBy, 'export_generated', 'report_snapshot', report.snapshotId, { exportId, sections })

    const download = await storage.object.download(objectKey)
    if (typeof (download as { getWebUrl?: unknown }).getWebUrl !== 'function') {
      throw new Error(`object download url failed: ${JSON.stringify(download).slice(0, 150)}`)
    }
    const downloadUrl = (download as { getWebUrl(): string }).getWebUrl()

    return {
      exportId,
      objectKey,
      downloadUrl,
      expiresHint: '链接 1 小时内有效，过期后请重新导出',
    }
  }

  private renderValueHighlights(doc: PDFKit.PDFDocument, report: PdfReportData) {
    doc.addPage()
    doc.fontSize(14).fillColor('#1f2733').text('价值亮点')
    doc.moveDown(0.4)
    const m = report.metrics
    const rows: Array<[string, string]> = [
      ['新建项目 / 活跃项目', `${m.projects.newProjects} / ${m.projects.activeProjects}`],
      ['迭代：新建 / 终态 / 按期', `${m.sprints.created} / ${m.sprints.finished} / ${m.sprints.onTimeFinished}`],
      ['工作项：创建 / 首次完成 / 重开', `${m.issues.created} / ${m.issues.firstCompleted} / ${m.issues.reopened}`],
      [
        '交付周期 P50 / P75',
        m.cycleTime.p50Hours != null ? `${m.cycleTime.p50Hours} / ${m.cycleTime.p75Hours} 小时（n=${m.cycleTime.sampleSize}）` : '样本不足',
      ],
      ['协作：人工变更 / 参与人数', `${m.collaboration.manualFieldChanges} / ${m.collaboration.participants}`],
      [
        '计划兑现率',
        m.planFulfillment.rate != null
          ? `${Math.round(m.planFulfillment.rate * 100)}%（${m.planFulfillment.onTime}/${m.planFulfillment.total}）`
          : '样本不足',
      ],
    ]
    for (const [label, value] of rows) {
      doc.fontSize(10.5).fillColor('#4a5568').text(`· ${label}`, { continued: true })
      doc.fontSize(10.5).fillColor('#1f2733').text(`　${value}`)
      doc.moveDown(0.15)
    }
  }

  private renderHealthPlaceholder(doc: PDFKit.PDFDocument) {
    doc.moveDown(0.8)
    doc.fontSize(14).fillColor('#1f2733').text('应用健康度')
    doc.moveDown(0.3)
    doc
      .fontSize(9.5)
      .fillColor('#6b7482')
      .text('健康度成熟度矩阵将在完整版本中展示（配置 → 活跃 → 闭环评估）。本报告的维度评估基于可验证的开放接口数据。', { lineGap: 3 })
  }

  private renderOpportunitiesPlaceholder(doc: PDFKit.PDFDocument) {
    doc.moveDown(0.8)
    doc.fontSize(14).fillColor('#1f2733').text('增购机会建议')
    doc.moveDown(0.3)
    doc
      .fontSize(9.5)
      .fillColor('#6b7482')
      .text('未购买模块不计入健康度。基于现有业务证据的增购建议需由 CSM 在预览页确认后展示（完整版本提供）。', { lineGap: 3 })
  }

  private horizontalRule(doc: PDFKit.PDFDocument) {
    const y = doc.y
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#dde3ee').stroke()
    doc.y = y + 12
  }

  private fmtDate(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  }

  private fmtDateTime(ms: number): string {
    const d = new Date(ms)
    return `${this.fmtDate(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}
