import { Injectable } from '@nestjs/common'
import { storage } from '@ones-open/node-sdk'
import { randomUUID } from 'node:crypto'

/** entity key 仅允许 [_a-z0-9]{1,64} */
const toKey = (id: string): string => id.replace(/-/g, '_')
import { AuditService } from './audit.service'
import type { EvidenceRef } from '../types'

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

type NarrativeRevisionEntity = {
  revision_id: string
  snapshot_id: string
  editor_uuid: string
  narrative_json: string
  created_at: number
}

const snapshotEntity = storage.entity<SnapshotEntity>('report_snapshot')
const narrativeEntity = storage.entity<NarrativeRevisionEntity>('narrative_revision')

/** 报告读取：不可变指标快照 + 可编辑叙事 + 证据引用 */
@Injectable()
export class ReportsService {
  constructor(private readonly audit: AuditService) {}

  async getSnapshot(snapshotId: string) {
    const row = await snapshotEntity.get(toKey(snapshotId))
    if (!row) return undefined
    return {
      snapshotId: row.snapshot_id,
      jobId: row.job_id,
      teamUuid: row.team_uuid,
      period: { start: row.period_start, end: row.period_end },
      ruleVersion: row.rule_version,
      metrics: JSON.parse(row.metrics_json || '{}'),
      narrative: JSON.parse(row.narrative_json || '{}'),
      coverage: row.coverage,
      createdAt: row.created_at,
    }
  }

  async saveNarrative(snapshotId: string, editorUuid: string, narrative: Record<string, string>) {
    const row = await snapshotEntity.get(toKey(snapshotId))
    if (!row) {
      return { ok: false as const, error: 'snapshot not found' }
    }
    // 指标不可变：只更新 narrative_json，保留审计修订
    const revisionId = randomUUID()
    await narrativeEntity.set(toKey(revisionId), {
      revision_id: revisionId,
      snapshot_id: snapshotId,
      editor_uuid: editorUuid,
      narrative_json: JSON.stringify(narrative),
      created_at: Date.now(),
    })
    await snapshotEntity.set(toKey(snapshotId), { ...row, narrative_json: JSON.stringify(narrative) })
    await this.audit.record(row.team_uuid, editorUuid, 'narrative_edited', 'report_snapshot', snapshotId, { revisionId })
    return { ok: true as const, revisionId }
  }

  /** 指标口径与证据引用 */
  async getEvidence(snapshotId: string): Promise<EvidenceRef[] | undefined> {
    const snapshot = await this.getSnapshot(snapshotId)
    if (!snapshot) return undefined
    const metrics = snapshot.metrics as Record<string, { source?: string; collectedAt?: number; sampleSize?: number }>
    return Object.entries(metrics).map(([metric, envelope]) => ({
      metric,
      source: envelope?.source ?? 'unknown',
      collectedAt: envelope?.collectedAt ?? snapshot.createdAt,
      sampleSize: envelope?.sampleSize,
    }))
  }

  async listSnapshots(teamUuid: string, limit = 20) {
    const result = (await snapshotEntity.query().getMany()) as unknown
    const rows =
      (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<{ key: string; value: SnapshotEntity }>
    return rows
      .map(r => r.value)
      .filter(v => v && v.team_uuid === teamUuid)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
      .map(v => ({
        snapshotId: v.snapshot_id,
        period: { start: v.period_start, end: v.period_end },
        ruleVersion: v.rule_version,
        coverage: v.coverage,
        createdAt: v.created_at,
      }))
  }
}
