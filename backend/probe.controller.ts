import { Controller, Get, Query } from '@nestjs/common'
import { storage } from '@ones-open/node-sdk'
import { OpenApiClientService } from './services/openapi-client.service'
import { OpenApiTokenService } from './services/openapi-token.service'

/**
 * M2 验证端点（T5/T11/T2）：用 App Identity 实测 OpenAPI 与内部接口。
 * 仅用于开发阶段证据采集，M3 收敛为正式 collectors。
 */
@Controller('api/probe')
export class ProbeController {
  constructor(
    private readonly openApi: OpenApiClientService,
    private readonly tokenService: OpenApiTokenService,
  ) {}

  /** O-A13 组织团队列表 */
  @Get('teams')
  async probeTeams() {
    return this.wrap('account/teams')
  }

  /** O-A1 团队项目列表（含分页验证）；ids=1 时返回 uuid 摘要 */
  @Get('projects')
  async probeProjects(@Query('teamID') teamID: string, @Query('limit') limit?: string, @Query('ids') ids?: string) {
    if (ids) {
      const data = await this.openApi.get<{ data?: { list?: Array<Record<string, unknown>> } }>('project/projects', { teamID, limit })
      const list = data?.data?.list ?? []
      const first = list[0] ?? {}
      return { ok: true, count: list.length, sampleKeys: Object.keys(first).slice(0, 25), projects: list.slice(0, 5) }
    }
    return this.wrap('project/projects', { teamID, limit })
  }

  /** O-A2 Sprint 列表（T11：read:project:sprint scope 可用性） */
  @Get('sprints')
  async probeSprints(@Query('teamID') teamID: string, @Query('projectID') projectID: string) {
    return this.wrap(`project/projects/${projectID}/sprints`, { teamID })
  }

  /** O-A11 组织 license（购买判定正式路径） */
  @Get('licenses')
  async probeLicenses() {
    return this.wrap('license/apps')
  }

  /** O-A12 ONESQL（周期统计主力） */
  @Get('onesql')
  async probeOnesql(@Query('teamID') teamID: string, @Query('sql') sql: string) {
    try {
      const data = await this.openApi.post('v3alpha/onesql/query'.replace('v3alpha/', '../v3alpha/'), { query: sql }, { teamID })
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 300) }
    }
  }

  /** T2：内部接口鉴权验证——app token / 用户委托 token 两种方式调用页面内部 graphql */
  @Get('internal-graphql')
  async probeInternalGraphql(
    @Query('teamID') teamID: string,
    @Query('t') t: string,
    @Query('query') query: string,
    @Query('userID') userID?: string,
  ) {
    try {
      const baseUrl = await this.tokenService.getOnesBaseUrl()
      const url = `${baseUrl.replace(/\/$/, '')}/project/api/project/team/${teamID}/items/graphql?t=${encodeURIComponent(t)}`
      const hostedToken = process.env.ONES_HOSTED_TOKEN ?? ''
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hostedToken}`,
        },
        body: JSON.stringify({ query }),
      })
      const text = await resp.text()
      return { ok: resp.ok, status: resp.status, mode: userID ? 'user-delegated' : 'app', body: text.slice(0, 500) }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 300) }
    }
  }

  /** 字段元数据：searchIssueFields（找代码关联相关字段）；filter=code 时只返回代码相关 */
  @Get('issue-fields')
  async probeIssueFields(@Query('teamID') teamID: string, @Query('filter') filter?: string) {
    try {
      const data = await this.openApi.get<{ data?: { list?: Array<Record<string, unknown>> } }>('project/searchIssueFields', { teamID })
      const list = data?.data?.list ?? []
      if (filter === 'code') {
        const hits = list.filter(f => /code|commit|git|svn|merge|代码|提交/i.test(JSON.stringify(f)))
        return { ok: true, total: list.length, hits: hits.map(f => ({ id: f.id, name: f.name, type: f.fieldType, builtIn: f.builtIn })) }
      }
      const types = [...new Set(list.map(f => String(f.fieldType)))]
      return { ok: true, total: list.length, fieldTypes: types }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 300) }
    }
  }

  /** 工作项详情：fieldValues 是否含代码关联信息（T2 补充验证） */
  @Get('issue-detail')
  async probeIssueDetail(@Query('teamID') teamID: string, @Query('issueID') issueID: string) {
    try {
      const data = await this.openApi.get<Record<string, unknown>>(`project/issues/${issueID}`, { teamID })
      const s = JSON.stringify(data)
      return { ok: true, size: s.length, preview: s.slice(0, 800) }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 300) }
    }
  }

  /** 变更日志：代码提交关联是否产生 changelog（T2 补充验证） */
  @Get('changelog')
  async probeChangelog(@Query('teamID') teamID: string, @Query('issueID') issueID: string) {
    try {
      const data = await this.openApi.post('project/issueFields/changeLog/query', {
        issue_uuids: [issueID],
        limit: 50,
        cursor: '',
      }, { teamID })
      const s = JSON.stringify(data)
      return { ok: true, size: s.length, preview: s.slice(0, 900) }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 300) }
    }
  }

  /** 对象存储 URL 探测（dev 环境 s3-proxy-service 不可达问题定位） */
  @Get('object-url')
  async probeObjectUrl() {
    try {
      const upload = await storage.object.upload('probe_test.pdf')
      const info = upload as { getUrl?: () => string; getWebUrl?: () => string; getFields?: () => Record<string, string> }
      return {
        ok: true,
        getUrl: info.getUrl?.() ?? null,
        getWebUrl: info.getWebUrl?.() ?? null,
        fields: info.getFields ? Object.keys(info.getFields()) : null,
      }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 200) }
    }
  }

  private async wrap(path: string, query?: Record<string, string | undefined>) {
    try {
      const data = await this.openApi.get(path, query)
      const summary = JSON.stringify(data)
      return { ok: true, size: summary.length, preview: summary.slice(0, 400) }
    } catch (error) {
      return { ok: false, error: String((error as Error).message).slice(0, 300) }
    }
  }
}
