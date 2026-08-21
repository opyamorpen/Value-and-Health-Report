import { Injectable, CanActivate, ExecutionContext, HttpException } from '@nestjs/common'
import { storage } from '@ones-open/node-sdk'

/**
 * 白名单鉴权（分层控制，见 evidence-matrix R2）：
 * 平台限制——ONES.fetchApp 转发不携带可信用户身份（M6 实测），
 * 因此采用：user_uuid 对照白名单 + 全量审计 + OpenAPI 数据面 scope 限制。
 * 白名单由组织管理员/团队负责人在配置端点录入（仅白名单管理员或安装者可改）。
 */

type WhitelistEntity = {
  team_uuid: string
  user_uuid: string
  role: string
  added_by: string
  created_at: number
}

const whitelistEntity = storage.entity<WhitelistEntity>('permission_whitelist')

const toKey = (teamUuid: string, userUuid: string): string =>
  `${teamUuid}_${userUuid}`.toLowerCase().replace(/[^_a-z0-9]/g, '_').slice(0, 64)

@Injectable()
export class WhitelistGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const teamUuid = (request.query?.teamID ?? request.body?.teamID ?? '') as string
    const userUuid = (request.query?.userID ?? request.body?.userID ?? '') as string
    if (!teamUuid || !userUuid) {
      throw new HttpException({ ok: false, error: '身份参数缺失（teamID/userID）' }, 401)
    }
    const allowed = await whitelistEntity.get(toKey(teamUuid, userUuid))
    if (!allowed) {
      // 引导：团队白名单为空时，首个调用者自动成为 admin（否则无人能初始化）
      const isEmpty = (await this.countTeam(teamUuid)) === 0
      if (isEmpty) {
        await whitelistEntity.set(toKey(teamUuid, userUuid), {
          team_uuid: teamUuid,
          user_uuid: userUuid,
          role: 'admin',
          added_by: 'bootstrap',
          created_at: Date.now(),
        })
        request.whitelistUser = { teamUuid, userUuid, role: 'admin' }
        return true
      }
      throw new HttpException({ ok: false, error: '无访问权限（不在报告管理员白名单）' }, 403)
    }
    request.whitelistUser = { teamUuid, userUuid, role: allowed.role }
    return true
  }

  private async countTeam(teamUuid: string): Promise<number> {
    const result = (await whitelistEntity.query().getMany()) as unknown
    const rows =
      (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<{
        key: string
        value: WhitelistEntity
      }>
    return rows.filter(r => r.value && r.value.team_uuid === teamUuid).length
  }
}

@Injectable()
export class WhitelistService {
  async list(teamUuid: string) {
    const result = (await whitelistEntity.query().getMany()) as unknown
    const rows =
      (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<{
        key: string
        value: WhitelistEntity
      }>
    return rows
      .map(r => r.value)
      .filter(v => v && v.team_uuid === teamUuid)
      .map(v => ({ userUuid: v.user_uuid, role: v.role, addedBy: v.added_by, createdAt: v.created_at }))
  }

  async add(teamUuid: string, userUuid: string, role: string, addedBy: string) {
    if (!/^[_a-zA-Z0-9]{1,64}$/.test(userUuid)) {
      throw new Error('invalid user_uuid')
    }
    await whitelistEntity.set(toKey(teamUuid, userUuid), {
      team_uuid: teamUuid,
      user_uuid: userUuid,
      role,
      added_by: addedBy,
      created_at: Date.now(),
    })
  }

  async remove(teamUuid: string, userUuid: string) {
    await whitelistEntity.delete(toKey(teamUuid, userUuid))
  }
}
