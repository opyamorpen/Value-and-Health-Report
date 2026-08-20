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
  dueDate: string | null
  projectUuid: string
  sprintUuid?: string
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

export type CollectResult<T> = {
  data: T
  errors: string[]
}

/** changelog author.name 的系统标识（M2 实测确认） */
const isBotName = (name: string): boolean => name === '{{system_bot}}' || name === '系统' || name === 'BOT'

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

  /** O-A3/O-A12 工作项：用 ONESQL 按 createTime 过滤（列表端点无日期过滤） */
  async collectIssues(teamUuid: string, period: Period): Promise<CollectResult<CollectedIssue[]>> {
    const errors: string[] = []
    const issues: CollectedIssue[] = []
    try {
      const endMs = period.end
      // 当前周期 + 对比周期一次采集（compare 也用）；field013 为毫秒时间戳
      const startMsAll = period.compareStart
      const sql =
        `select uid(uuid), uid(field001), uid(field013), uid(field005.category), uid(field006.uuid), ` +
        `uid(field007.uuid), uid(field010) ` +
        `from issue where uid(field013) > ${startMsAll} and uid(field013) < ${endMs} ` +
        `order by field013 asc limit 10000`
      let cursorValue = ''
      for (let page = 0; page < 100; page++) {
        const pageSql = cursorValue
          ? sql.replace('limit 10000', `limit ${cursorValue}, 10000`)
          : sql
        const resp = await this.openApi.post<onesqlEnvelope>(
          '../v3alpha/onesql/query',
          { query: pageSql },
          { teamID: teamUuid },
        )
        if ((resp as { result?: string }).result === 'FAIL') {
          const fail = resp as unknown as { error_msg?: string; error_code?: string }
          throw new Error(`onesql FAIL ${fail.error_code ?? ''}: ${String(fail.error_msg ?? '').slice(0, 120)}`)
        }
        const rows = resp?.data?.data ?? []
        for (const row of rows) {
          const item = (row.item ?? {}) as Record<string, unknown>
          const statusField = item.field005 as { category?: string } | undefined
          const projectField = item.field006 as { uuid?: string } | undefined
          const sprintField = item.field007 as { uuid?: string } | undefined
          issues.push({
            uuid: String(item.uuid ?? ''),
            title: String(item.field001 ?? ''),
            createTime: Number(item.field013 ?? 0),
            statusCategory: String(statusField?.category ?? ''),
            dueDate: item.field010 != null ? String(item.field010) : null,
            projectUuid: String(projectField?.uuid ?? ''),
            sprintUuid: sprintField?.uuid ? String(sprintField.uuid) : undefined,
          })
        }
        if (rows.length < 10000) break
        cursorValue = String(page * 10000 + rows.length)
      }
    } catch (error) {
      errors.push(`issues: ${String((error as Error).message).slice(0, 150)}`)
    }
    return { data: issues, errors }
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

  /** 评论数：ONESQL 聚合（comment 计数按 issue） */
  async collectCommentCount(teamUuid: string, period: Period): Promise<CollectResult<number>> {
    try {
      const resp = await this.openApi.post<onesqlEnvelope>(
        '../v3alpha/onesql/query',
        {
          query: `select count(uid(uuid)) as total from issue where uid(field013) > ${period.compareStart} and uid(field013) < ${period.end}`,
        },
        { teamID: teamUuid },
      )
      const total = Number(resp?.data?.data?.[0]?.item?.total ?? 0)
      return { data: total, errors: [] }
    } catch (error) {
      return { data: 0, errors: [`commentCount: ${String((error as Error).message).slice(0, 150)}`] }
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
