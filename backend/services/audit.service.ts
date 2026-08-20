import { Injectable } from '@nestjs/common'
import { storage } from '@ones-open/node-sdk'
import { randomUUID } from 'node:crypto'

/** entity key 仅允许 [_a-z0-9]{1,64} */
const toKey = (id: string): string => id.replace(/-/g, '_')
import type { AuditAction } from '../types'

type AuditLogEntity = {
  log_id: string
  team_uuid: string
  actor_uuid: string
  action: string
  target_type: string
  target_id: string
  detail_json: string
  created_at: number
}

const auditEntity = storage.entity<AuditLogEntity>('audit_log')

/** 审计日志：生成/补证/文案修改/导出/删除全部记录 */
@Injectable()
export class AuditService {
  async record(
    teamUuid: string,
    actorUuid: string,
    action: AuditAction,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const logId = randomUUID()
    await auditEntity.set(toKey(logId), {
      log_id: logId,
      team_uuid: teamUuid,
      actor_uuid: actorUuid,
      action,
      target_type: targetType,
      target_id: targetId,
      detail_json: JSON.stringify(detail),
      created_at: Date.now(),
    })
  }

  async listByTeam(teamUuid: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    const result = (await auditEntity.query().getMany()) as unknown
    const rows =
      (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<{ key: string; value: AuditLogEntity }>
    return rows
      .map(r => r.value)
      .filter(v => v && v.team_uuid === teamUuid)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
      .map(v => ({
        logId: v.log_id,
        actorUuid: v.actor_uuid,
        action: v.action,
        targetType: v.target_type,
        targetId: v.target_id,
        detail: JSON.parse(v.detail_json || '{}'),
        createdAt: v.created_at,
      }))
  }
}
