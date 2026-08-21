import { Injectable } from '@nestjs/common'
import { OpenApiClientService } from './openapi-client.service'
import type { Period } from '../types'

/**
 * 采集层：OpenAPI 数据采集（O-A1~A14，见 docs/evidence-matrix.md）。
 * 统一处理 cursor 分页（limit≤100）、机器人过滤（{{system_bot}}/BOT）。
 * 单个数据源失败返回 partial 结果（collector 内捕获，由 metrics 层决定降级）。
 */

export type CollectedProject = {
  uuid: string
  name: string
  createTime: number
  status: string
  statusCategory: string
  isArchive: boolean
}

export type CollectedSprint = {
  uuid: string
  name: string
  status: string
  startDate?: number
  endDate?: number
  finishTime?: number
}

export type CollectedIssue = {
  uuid: string
  title: string
  createTime: number
  statusCategory: string
  /** field010 截止日期（原口径保留；spec 实为 Updated time，一致性靠运行时验证） */
  dueDate: string | null
  projectUuid: string
  /** field011 Sprint UUID */
  sprintUuid?: string
  /** field007 工作项类型 UUID */
  issueTypeUuid?: string
  /** field004 负责人 UUID */
  assigneeUuid?: string
  /** field018 预估工时（float，value = floor(实际值 × 100000)） */
  timeEstimated?: number
  /** field048 关联 Wiki（值非空即视为已关联；结构不假定） */
  wikiLinked?: boolean
}

/** 工作项类型（O: project/issueTypes，需 read:project:issueType） */
export type CollectedIssueType = {
  uuid: string
  name: string
  isSub: boolean
}

/** 工作项类型分类（value-standard §4.1 关键词映射） */
export type IssueTypeCategory = 'requirement' | 'defect' | 'task' | 'unclassified'

export const classifyIssueType = (name: string): IssueTypeCategory => {
  const n = name.toLowerCase()
  if (/需求|requirement|story|epic|feature/.test(name) || /requirement|story|epic|feature/.test(n)) return 'requirement'
  if (/缺陷|bug|defect|故障/.test(name) || /bug|defect/.test(n)) return 'defect'
  if (/任务|task/.test(name) || /task/.test(n)) return 'task'
  return 'unclassified'
}

export type CollectedChangeRecord = {
  issueUuid: string
  versionUuid: string
  createTime: number
  fieldUuid: string
  fieldName: string
  fieldType: string
  oldValue: string | null
  newValue: string | null
  authorUuid: string
  authorName: string
  isBot: boolean
}

export type CollectedWorklog = {
  uuid: string
  issueUuid: string
  userUuid: string
  createTime: number
  hours: number
}

/** 预估工时（O-A5：团队级，issueID 汇总） */
export type CollectedEstimate = {
  issueUuid: string
  /** 秒（spec TimesEstimated hours 为秒） */
  seconds: number
}

/** 登记工时（O-A6：逐工作项 simple/timesSpent） */
export type CollectedSpent = {
  issueUuid: string
  seconds: number
  records: number
}

export type CollectResult<T> = {
  data: T
  errors: string[]
}

/** changelog author.name 的系统标识（M2 实测确认） */
export const isBotName = (name: string): boolean => name === '{{system_bot}}' || name === '系统' || name === 'BOT'

/** ONES createTime 为微秒时间戳（16 位），统一转毫秒 */
export const normalizeTimestampMs = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  const abs = Math.abs(value)
  if (abs < 1e11) return value * 1000
  if (abs < 1e14) return value
  if (abs < 1e17) return Math.floor(value / 1000)
  return Math.floor(value / 1_000_000)
}

@Injectable()
export class CollectorsService {
  constructor(private readonly openApi: OpenApiClientService) {}

  /** O-A1 项目列表（cursor 分页） */
  async collectProjects(teamUuid: string): Promise<CollectResult<CollectedProject[]>> {
    const errors: string[] = []
    const projects: CollectedProject[] = []
    let cursor: string | undefined
    try {
      for (let page = 0; page < 100; page++) {
        const resp = await this.openApi.get<{
          data?: { list?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
        }>('project/projects', { teamID: teamUuid, limit: 100, cursor })
        const list = resp?.data?.list ?? []
        for (const item of list) {
          projects.push({
            uuid: String(item.id ?? ''),
            name: String(item.name ?? ''),
            createTime: normalizeTimestampMs(Number(item.createTime ?? 0)),
            status: String(item.status ?? ''),
            statusCategory: String(item.statusCategory ?? ''),
            isArchive: Boolean(item.isArchive),
          })
        }
        const pageInfo = resp?.data?.pageInfo
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
        cursor = pageInfo.endCursor
      }
    } catch (error) {
      errors.push(`projects: ${String((error as Error).message).slice(0, 150)}`)
    }
    return { data: projects, errors }
  }

  /** O-A2 Sprint 列表（不分页，逐项目拉取） */
  async collectSprints(teamUuid: string, projectUuids: string[]): Promise<CollectResult<CollectedSprint[]>> {
    const errors: string[] = []
    const sprints: CollectedSprint[] = []
    for (const projectUuid of projectUuids) {
      try {
        const resp = await this.openApi.get<{ data?: { list?: Array<Record<string, unknown>> } }>(
          `project/projects/${projectUuid}/sprints`,
          { teamID: teamUuid },
        )
        for (const item of resp?.data?.list ?? []) {
          sprints.push({
            uuid: String(item.id ?? item.uuid ?? ''),
            name: String(item.name ?? ''),
            status: String(item.status ?? ''),
            startDate: item.startDate ? normalizeTimestampMs(Number(item.startDate)) : undefined,
            endDate: item.endDate ? normalizeTimestampMs(Number(item.endDate)) : undefined,
            finishTime: item.finishTime ? normalizeTimestampMs(Number(item.finishTime)) : undefined,
          })
        }
      } catch (error) {
        // 单项目失败不阻塞整体（局部成功）
        errors.push(`sprints(${projectUuid}): ${String((error as Error).message).slice(0, 100)}`)
      }
    }
    return { data: sprints, errors }
  }

  /** O: project/issueTypes 工作项类型清单（field007 uuid → name 映射） */
  async collectIssueTypes(teamUuid: string): Promise<CollectResult<CollectedIssueType[]>> {
    const errors: string[] = []
    const types: CollectedIssueType[] = []
    try {
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const resp = await this.openApi.get<{
          data?: { list?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
        }>('project/issueTypes', { teamID: teamUuid, limit: 100, cursor })
        for (const item of resp?.data?.list ?? []) {
          types.push({
            uuid: String(item.id ?? ''),
            name: String(item.name ?? ''),
            isSub: Boolean(item.isSubIssueType),
          })
        }
        const pageInfo = resp?.data?.pageInfo
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
        cursor = pageInfo.endCursor
      }
    } catch (error) {
      errors.push(`issueTypes: ${String((error as Error).message).slice(0, 150)}`)
    }
    return { data: types, errors }
  }

  /** O-A3/O-A12 工作项：用 ONESQL 按 createTime 过滤（列表端点无日期过滤）。
   *  v0.2 扩列（T14 契约）：field007=工作项类型、field004=负责人、field011=Sprint、field018=预估工时、field048=关联 Wiki。
   *  任一扩列 FAIL 时按无该列重试一次（渐进降级，字段缺失不阻塞采集）。 */
  async collectIssues(teamUuid: string, period: Period): Promise<CollectResult<CollectedIssue[]>> {
    const errors: string[] = []
    let issues: CollectedIssue[] = []
    const extendedCols = `, uid(field007.uuid), uid(field004.uuid), uid(field011.uuid), uid(field018), uid(field048) `
    const baseSql = (extra: string) =>
      `select uid(uuid), uid(field001), uid(field013), uid(field005.category), uid(field006.uuid), ` +
      `uid(field010)${extra}` +
      `from issue where uid(field013) > ${period.compareStart} and uid(field013) < ${period.end} ` +
      `order by field013 asc limit 10000`
    try {
      const result = await this.queryIssues(teamUuid, baseSql(extendedCols))
      issues = result.issues
      errors.push(...result.errors)
      if (result.failed) {
        // 扩列失败（自定义字段/field048 不存在等）：回退基础列
        errors.push('issues: extended columns unavailable, fallback to base columns')
        const fallback = await this.queryIssues(teamUuid, baseSql(' '))
        issues = fallback.issues
        errors.push(...fallback.errors)
      }
    } catch (error) {
      errors.push(`issues: ${String((error as Error).message).slice(0, 150)}`)
    }
    return { data: issues, errors }
  }

  private async queryIssues(
    teamUuid: string,
    sql: string,
  ): Promise<{ issues: CollectedIssue[]; errors: string[]; failed: boolean }> {
    const errors: string[] = []
    const issues: CollectedIssue[] = []
    let cursorValue = ''
    for (let page = 0; page < 100; page++) {
      const pageSql = cursorValue ? sql.replace('limit 10000', `limit ${cursorValue}, 10000`) : sql
      const resp = await this.openApi.post<onesqlEnvelope>(
        '../v3alpha/onesql/query',
        { query: pageSql },
        { teamID: teamUuid },
      )
      if ((resp as { result?: string }).result === 'FAIL') {
        const fail = resp as unknown as { error_msg?: string; error_code?: string }
        // 扩列查询失败标记 failed，由调用方决定是否降级重试
        return {
          issues,
          errors: [`onesql FAIL ${fail.error_code ?? ''}: ${String(fail.error_msg ?? '').slice(0, 120)}`],
          failed: true,
        }
      }
      const rows = resp?.data?.data ?? []
      for (const row of rows) {
        const item = (row.item ?? {}) as Record<string, unknown>
        const statusField = item.field005 as { category?: string } | undefined
        const projectField = item.field006 as { uuid?: string } | undefined
        const typeField = item.field007 as { uuid?: string } | undefined
        const assigneeField = item.field004 as { uuid?: string } | undefined
        const sprintField = item.field011 as { uuid?: string } | undefined
        issues.push({
          uuid: String(item.uuid ?? ''),
          title: String(item.field001 ?? ''),
          createTime: Number(item.field013 ?? 0),
          statusCategory: String(statusField?.category ?? ''),
          dueDate: item.field010 != null ? String(item.field010) : null,
          projectUuid: String(projectField?.uuid ?? ''),
          issueTypeUuid: typeField?.uuid ? String(typeField.uuid) : undefined,
          assigneeUuid: assigneeField?.uuid ? String(assigneeField.uuid) : undefined,
          sprintUuid: sprintField?.uuid ? String(sprintField.uuid) : undefined,
          // float 字段值 = floor(实际值 × 100000)
          timeEstimated: item.field018 != null && Number.isFinite(Number(item.field018))
            ? Number(item.field018) / 100000
            : undefined,
          wikiLinked: item.field048 != null && item.field048 !== '' ? true : undefined,
        })
      }
      if (rows.length < 10000) break
      cursorValue = String(page * 10000 + rows.length)
    }
    return { issues, errors, failed: false }
  }

  /** O-A4 变更日志（按 issue 分批，≤1000/批；10000 条截断标记） */
  async collectChangelogs(
    teamUuid: string,
    issueUuids: string[],
  ): Promise<CollectResult<CollectedChangeRecord[]>> {
    const errors: string[] = []
    const records: CollectedChangeRecord[] = []
    const batch = 1000
    for (let i = 0; i < issueUuids.length; i += batch) {
      const uuids = issueUuids.slice(i, i + batch)
      let cursor = ''
      try {
        for (let page = 0; page < 50; page++) {
          const resp = await this.openApi.post<changelogEnvelope>(
            'project/issueFields/changeLog/query',
            {
              issue_uuids: uuids,
              limit: 1000,
              cursor,
            },
            { teamID: teamUuid },
          )
          const data = resp?.data
          if (data?.records_truncated) {
            errors.push(`changelog: truncated at 10000 (batch ${Math.floor(i / batch) + 1})`)
          }
          for (const record of data?.records ?? []) {
            for (const item of record.records ?? []) {
              const author = item.author ?? {}
              records.push({
                issueUuid: record.issue_uuid,
                versionUuid: item.version_uuid,
                createTime: Number(item.create_time ?? 0),
                fieldUuid: item.field_uuid,
                fieldName: item.field_name,
                fieldType: item.field_type,
                oldValue: item.old_value ?? null,
                newValue: item.new_value ?? null,
                authorUuid: author.uuid ?? '',
                authorName: author.name ?? '',
                isBot: isBotName(author.name ?? ''),
              })
            }
          }
          const pageInfo = data?.page_info
          if (!pageInfo?.has_next_page || !pageInfo.end_cursor) break
          cursor = pageInfo.end_cursor
        }
      } catch (error) {
        errors.push(`changelog(batch ${Math.floor(i / batch) + 1}): ${String((error as Error).message).slice(0, 100)}`)
      }
    }
    return { data: records, errors }
  }

  /** O-A5 预估工时（团队级按周期；issueID 空时全量。hours 单位为秒） */
  async collectEstimates(
    teamUuid: string,
    period: Period,
  ): Promise<CollectResult<CollectedEstimate[]>> {
    const errors: string[] = []
    const estimates: CollectedEstimate[] = []
    const start = new Date(period.compareStart).toISOString().slice(0, 10)
    const end = new Date(period.end).toISOString().slice(0, 10)
    try {
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const resp = await this.openApi.get<{
          data?: { list?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
        }>('project/workLog/timesEstimated', {
          teamID: teamUuid,
          startDate: start,
          endDate: end,
          limit: 100,
          cursor,
        })
        for (const item of resp?.data?.list ?? []) {
          estimates.push({
            issueUuid: String(item.issueID ?? item.issueUuid ?? ''),
            seconds: Number(item.hours ?? 0),
          })
        }
        const pageInfo = resp?.data?.pageInfo
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
        cursor = pageInfo.endCursor
      }
    } catch (error) {
      errors.push(`estimates: ${String((error as Error).message).slice(0, 150)}`)
    }
    return { data: estimates, errors }
  }

  /** O-A6 登记工时（逐工作项；maxIssues 控制调用量——value-standard §7.4 采样上限） */
  async collectSpent(
    teamUuid: string,
    issueUuids: string[],
    maxIssues = 500,
  ): Promise<CollectResult<CollectedSpent[]>> {
    const errors: string[] = []
    const spent: CollectedSpent[] = []
    const targets = issueUuids.slice(0, maxIssues)
    let failures = 0
    for (const issueUuid of targets) {
      try {
        const resp = await this.openApi.get<{ data?: { list?: Array<Record<string, unknown>> } }>(
          `project/issues/${issueUuid}/workLog/simple/timesSpent`,
          { teamID: teamUuid, limit: 100 },
        )
        const list = resp?.data?.list ?? []
        let seconds = 0
        for (const item of list) {
          seconds += Number(item.hours ?? 0)
        }
        if (list.length) {
          spent.push({ issueUuid, seconds, records: list.length })
        }
      } catch (error) {
        failures++
        if (failures <= 3) {
          errors.push(`spent(${issueUuid}): ${String((error as Error).message).slice(0, 100)}`)
        }
        if (failures >= 20) {
          errors.push(`spent: aborted after 20 failures (${targets.length} targets)`)
          break
        }
      }
    }
    if (targets.length < issueUuids.length) {
      errors.push(`spent: sampled ${targets.length}/${issueUuids.length} issues (cap ${maxIssues})`)
    }
    return { data: spent, errors }
  }

  /** O-A7 Wiki 空间数（参考值，D1 知识沉淀） */
  async collectWikiSpaceCount(teamUuid: string): Promise<CollectResult<number>> {
    try {
      const resp = await this.openApi.get<{ data?: { list?: unknown[] } }>('wiki/spaces', { teamID: teamUuid })
      return { data: (resp?.data?.list ?? []).length, errors: [] }
    } catch (error) {
      return { data: 0, errors: [`wikiSpaces: ${String((error as Error).message).slice(0, 150)}`] }
    }
  }
}

type onesqlEnvelope = {
  data?: {
    data?: Array<{ type: string; item: Record<string, unknown> }>
  }
}

type changelogEnvelope = {
  data?: {
    records?: Array<{
      issue_uuid: string
      records?: Array<{
        version_uuid: string
        create_time: number
        field_uuid: string
        field_name: string
        field_type: string
        old_value?: string | null
        new_value?: string | null
        author?: { uuid?: string; name?: string }
      }>
    }>
    page_info?: { has_next_page?: boolean; end_cursor?: string }
    records_truncated?: boolean
  }
}
