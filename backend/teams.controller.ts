import { Controller, Get, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { OpenApiClientService } from './services/openapi-client.service'
import { WhitelistService } from './services/whitelist.service'

/**
 * 团队列表端点（团队选择器数据源）。
 * O-A13 account/teams 返回组织内团队清单（uuid/name，产品内任何成员可见的元数据，
 * 不属于报告业务数据），因此不走 WhitelistGuard；但附带单次白名单扫描的访问标注，
 * 前端据此禁用无权限团队。报告数据本身仍由 /api/* 白名单守卫保护。
 */
@Controller('api')
export class TeamsController {
  constructor(
    private readonly openApi: OpenApiClientService,
    private readonly whitelist: WhitelistService,
  ) {}

  @Get('teams')
  async listTeams(@Query('userID') userUuid: string, @Res({ passthrough: true }) res: Response) {
    if (!userUuid) {
      res.status(401)
      return { ok: false, error: 'userID required' }
    }
    try {
      const resp = await this.openApi.get<{ data?: { teams?: Array<{ id?: string; name?: string; status?: number }> } }>(
        'account/teams',
      )
      const teams = resp?.data?.teams ?? []
      const entries = await this.whitelist.listAll()
      const whitelistedTeams = new Set(
        entries.filter(e => e.user_uuid === userUuid).map(e => e.team_uuid),
      )
      const teamCounts = new Map<string, number>()
      for (const e of entries) {
        teamCounts.set(e.team_uuid, (teamCounts.get(e.team_uuid) ?? 0) + 1)
      }
      return {
        ok: true,
        teams: teams.map(t => {
          const uuid = String(t.id ?? '')
          const whitelisted = whitelistedTeams.has(uuid)
          const whitelistEmpty = (teamCounts.get(uuid) ?? 0) === 0
          return {
            uuid,
            name: String(t.name ?? ''),
            // 空白名单团队首个访问者会 bootstrap 为 admin，视为可进入
            accessible: whitelisted || whitelistEmpty,
            whitelisted,
            whitelistEmpty,
          }
        }),
      }
    } catch (error) {
      res.status(502)
      return { ok: false, error: String((error as Error).message).slice(0, 150) }
    }
  }
}
