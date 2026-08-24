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

type PdfHealthMatrix = {
  results: Array<{ dimension: string; maturity: string; suggestion?: string }>
  opportunities: Array<{ moduleName: string; reason: string }>
}

type PdfCompared = {
  current: number | null
  previous: number | null
  delta: number | null
  deltaPercent: number | null
  deltaPP: number | null
  trendLabel: string
  direction: 'up' | 'down' | 'neutral'
  isImprovement: boolean | null
  sampleSize: number
}

type PdfValueMetrics = {
  scope: { activeProjects: PdfCompared; newProjects: number }
  requirement: { typeSplit: boolean; created: PdfCompared; delivered: PdfCompared; cycleP50Hours: PdfCompared; onTimeRate: PdfCompared; sprintLinkedRate: PdfCompared }
  defect: { typeSplit: boolean; found: PdfCompared; fixed: PdfCompared; open: number; fixCycleP50Hours: PdfCompared; reopenRate: PdfCompared }
  sprintExecution: { finished: PdfCompared; onTimeRate: PdfCompared; deliveredItems: PdfCompared; cadenceWeeks: number }
  deliveryEfficiency: { cycleP50Hours: PdfCompared; cycleP75Hours: PdfCompared; weeklyThroughput: PdfCompared; onTimeRate: PdfCompared; reopenRate: PdfCompared }
  collaboration: { participants: PdfCompared; manualActions: PdfCompared; activeWeeks: number }
  discipline: { assigneeFillRate: PdfCompared; dueDateFillRate: PdfCompared; sprintDateDisciplineRate: PdfCompared; sprintLengthMedianDays: number | null }
  worklogPractice: { estimateCoverage: PdfCompared; spentCoverage: PdfCompared; estimateAccuracyMedian: number | null; pairedSampleSize: number }
  knowledge: { wikiLinkedCount: PdfCompared; wikiLinkedRate: PdfCompared; wikiSpaces: number | null }
  highlights: Array<{ text: string; kind: string }>
  concerns: Array<{ text: string }>
}

type PdfReportData = {
  snapshotId: string
  teamUuid: string
  period: { start: number; end: number }
  ruleVersion: string
  coverage: number
  healthMatrix?: PdfHealthMatrix
  metrics: PdfValueMetrics | Record<string, unknown>
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
      this.renderHealthMatrix(doc, report)
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

  /** 价值板块（value-standard v0.2）：价值亮点 → 四轴分组指标（含环比）→ 需关注；旧结构回退简版 */
  private renderValueHighlights(doc: PDFKit.PDFDocument, report: PdfReportData) {
    doc.addPage()
    const m = report.metrics
    const isV2 = (mm: PdfReportData['metrics']): mm is PdfValueMetrics =>
      typeof mm === 'object' && mm !== null && 'scope' in mm && 'highlights' in mm

    if (!isV2(m)) {
      this.renderValueHighlightsLegacy(doc, m as Record<string, unknown>)
      return
    }

    // 价值亮点（置顶）
    doc.fontSize(14).fillColor('#1f2733').text('价值亮点')
    doc.moveDown(0.3)
    if (m.highlights.length) {
      for (const h of m.highlights) {
        doc.fontSize(11).fillColor('#1e8e4e').text(`✓ ${h.text}`, { lineGap: 3 })
      }
    } else {
      doc.fontSize(10).fillColor('#6b7482').text('本周期无显著环比改善亮点。', { lineGap: 3 })
    }
    if (m.concerns?.length) {
      doc.moveDown(0.3)
      doc.fontSize(11).fillColor('#b25e00')
      for (const c of m.concerns) {
        doc.text(`△ ${c.text}`, { lineGap: 3 })
      }
    }

    // 环比展示：当前值 + (前值→当前 Δ)
    const val = (cmp: PdfCompared, kind: 'count' | 'ratio' | 'hours' = 'count'): string => {
      if (cmp == null || cmp.current == null) return '未知'
      const base = kind === 'ratio' ? `${Math.round(cmp.current * 100)}%` : kind === 'hours' ? `${cmp.current} 小时` : String(cmp.current)
      if (cmp.trendLabel === '未知' || cmp.previous == null) return base
      if (cmp.trendLabel === '基本持平') return `${base}（环比持平）`
      if (cmp.trendLabel === '新增') return `${base}（新增）`
      const delta = kind === 'ratio'
        ? `${cmp.deltaPP != null && cmp.deltaPP > 0 ? '+' : ''}${cmp.deltaPP ?? 0}pp`
        : `${cmp.deltaPercent != null && cmp.deltaPercent > 0 ? '+' : ''}${cmp.deltaPercent ?? 0}%`
      return `${base}（环比 ${delta}）`
    }
    const plain = (v: number | null, unit = ''): string => (v != null ? `${v}${unit}` : '未知')

    doc.moveDown(0.6)
    doc.fontSize(14).fillColor('#1f2733').text('价值指标（对比上一周期）')
    doc.moveDown(0.3)

    const groups: Array<{ title: string; rows: Array<[string, string]> }> = [
      {
        title: 'A · 价值成果',
        rows: [
          ['需求数', val(m.requirement.created)],
          ['需求交付量', val(m.requirement.delivered)],
          ['需求交付周期 P50', val(m.requirement.cycleP50Hours, 'hours')],
          ['需求按期率', val(m.requirement.onTimeRate, 'ratio')],
          ['迭代纳入率', val(m.requirement.sprintLinkedRate, 'ratio')],
          ['缺陷发现 / 修复 / 遗留', `${val(m.defect.found)} / ${val(m.defect.fixed)} / ${m.defect.open}`],
          ['缺陷修复周期 P50', val(m.defect.fixCycleP50Hours, 'hours')],
          ['缺陷重开率', val(m.defect.reopenRate, 'ratio')],
          ['完成迭代数', val(m.sprintExecution.finished)],
          ['迭代按期率', val(m.sprintExecution.onTimeRate, 'ratio')],
          ['迭代交付工作项', val(m.sprintExecution.deliveredItems)],
        ],
      },
      {
        title: 'B · 效率与确定性',
        rows: [
          ['交付周期 P50 / P75', `${val(m.deliveryEfficiency.cycleP50Hours, 'hours')} / ${val(m.deliveryEfficiency.cycleP75Hours, 'hours')}`],
          ['周均完成吞吐', val(m.deliveryEfficiency.weeklyThroughput)],
          ['按期完成率', val(m.deliveryEfficiency.onTimeRate, 'ratio')],
          ['重开率', val(m.deliveryEfficiency.reopenRate, 'ratio')],
        ],
      },
      {
        title: 'C · 协作与管理',
        rows: [
          ['协作参与人数', val(m.collaboration.participants)],
          ['人工协作行为', val(m.collaboration.manualActions)],
          ['协作持续性', `${m.collaboration.activeWeeks} 个自然周`],
          ['负责人填写率', val(m.discipline.assigneeFillRate, 'ratio')],
          ['截止日期填写率', val(m.discipline.dueDateFillRate, 'ratio')],
          ['迭代日期规范率', val(m.discipline.sprintDateDisciplineRate, 'ratio')],
          ['工时预估覆盖率', val(m.worklogPractice.estimateCoverage, 'ratio')],
          ['工时登记覆盖率', val(m.worklogPractice.spentCoverage, 'ratio')],
          ['预估准确度', m.worklogPractice.estimateAccuracyMedian != null ? `偏差中位数 ${Math.round(m.worklogPractice.estimateAccuracyMedian * 100)}%` : '样本不足'],
        ],
      },
      {
        title: 'D · 资产沉淀',
        rows: [
          ['关联 Wiki 工作项', val(m.knowledge.wikiLinkedCount)],
          ['知识沉淀率', val(m.knowledge.wikiLinkedRate, 'ratio')],
          ['Wiki 空间数', plain(m.knowledge.wikiSpaces)],
        ],
      },
    ]

    for (const g of groups) {
      doc.fontSize(12).fillColor('#1f2733').text(g.title)
      doc.moveDown(0.15)
      for (const [label, value] of g.rows) {
        doc.fontSize(10.5).fillColor('#4a5568').text(`· ${label}`, { continued: true })
        doc.fontSize(10.5).fillColor('#1f2733').text(`　${value}`)
        doc.moveDown(0.1)
      }
      doc.moveDown(0.25)
    }

    if (!m.requirement.typeSplit) {
      doc.fontSize(9.5).fillColor('#8b93a3').text('注：工作项类型映射覆盖率不足，需求/缺陷指标按全类型口径。', { lineGap: 3 })
    }
  }

  /** v0.1 旧快照的简版价值板块 */
  private renderValueHighlightsLegacy(doc: PDFKit.PDFDocument, m: Record<string, unknown>) {
    doc.fontSize(14).fillColor('#1f2733').text('价值亮点')
    doc.moveDown(0.4)
    const pick = <T,>(obj: Record<string, unknown>, path: string): T | undefined =>
      path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj) as T | undefined
    const rows: Array<[string, string]> = [
      [
        '新建项目 / 活跃项目',
        `${pick<number>(m, 'projects.newProjects') ?? 0} / ${pick<number>(m, 'projects.activeProjects') ?? 0}`,
      ],
      [
        '迭代：终态 / 按期',
        `${pick<number>(m, 'sprints.finished') ?? 0} / ${pick<number>(m, 'sprints.onTimeFinished') ?? 0}`,
      ],
      [
        '工作项：创建 / 首次完成 / 重开',
        `${pick<number>(m, 'issues.created') ?? 0} / ${pick<number>(m, 'issues.firstCompleted') ?? 0} / ${pick<number>(m, 'issues.reopened') ?? 0}`,
      ],
      [
        '交付周期 P50 / P75',
        pick<number>(m, 'cycleTime.p50Hours') != null
          ? `${pick<number>(m, 'cycleTime.p50Hours')} / ${pick<number>(m, 'cycleTime.p75Hours')} 小时`
          : '样本不足',
      ],
      [
        '协作：人工变更 / 参与人数',
        `${pick<number>(m, 'collaboration.manualFieldChanges') ?? 0} / ${pick<number>(m, 'collaboration.participants') ?? 0}`,
      ],
      [
        '计划兑现率',
        pick<number>(m, 'planFulfillment.rate') != null
          ? `${Math.round((pick<number>(m, 'planFulfillment.rate') ?? 0) * 100)}%`
          : '样本不足',
      ],
    ]
    for (const [label, value] of rows) {
      doc.fontSize(10.5).fillColor('#4a5568').text(`· ${label}`, { continued: true })
      doc.fontSize(10.5).fillColor('#1f2733').text(`　${value}`)
      doc.moveDown(0.15)
    }
  }

  /** 客户版健康度：仅维度+成熟度+建议；内部原因（reason/接口细节）不进入客户版 PDF */
  private renderHealthMatrix(doc: PDFKit.PDFDocument, report: PdfReportData) {
    doc.addPage()
    doc.fontSize(14).fillColor('#1f2733').text('应用健康度')
    doc.moveDown(0.4)
    const matrix = report.healthMatrix
    if (!matrix || !matrix.results.length) {
      doc.fontSize(9.5).fillColor('#6b7482').text('暂无可用的健康度数据。', { lineGap: 3 })
      return
    }
    for (const r of matrix.results) {
      doc.fontSize(10.5).fillColor('#4a5568').text(`· ${r.dimension}`, { continued: true })
      doc.fontSize(10.5).fillColor('#1f2733').text(`　${r.maturity}`)
      if (r.suggestion) {
        doc.fontSize(9).fillColor('#6b7482').text(`  建议：${r.suggestion}`, { indent: 14 })
      }
      doc.moveDown(0.1)
    }
    if (matrix.opportunities?.length) {
      doc.moveDown(0.6)
      doc.fontSize(12).fillColor('#1f2733').text('增购机会（未购模块不计入健康度）')
      doc.moveDown(0.2)
      for (const o of matrix.opportunities) {
        doc.fontSize(10).fillColor('#4a5568').text(`· ${o.moduleName}：${o.reason}`)
        doc.moveDown(0.1)
      }
    }
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
