import { OpenApiClientService } from '../services/openapi-client.service'
import type { OpenApiTokenService } from '../services/openapi-token.service'

/**
 * M5 韧性测试（README 实施步骤 5）：
 * 分页、限流退避、401 刷新重试、403 分类、ONESQL FAIL 检测、部分失败、截断标记。
 */

const makeClient = (_fetchImpl: unknown, tokenService: Partial<OpenApiTokenService>) =>
  new OpenApiClientService(tokenService as OpenApiTokenService)

/** 替换全局 fetch（OpenApiClientService 直接调用全局 fetch） */
const stubFetch = (impl: (url: URL, init?: RequestInit) => Promise<Response>) => {
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const tokenServiceStub = (over: Partial<OpenApiTokenService> = {}): OpenApiTokenService =>
  ({
    getAppAccessToken: async () => 'token-1',
    getUserAccessToken: async () => 'user-token',
    invalidateToken: jest.fn(),
    getOnesBaseUrl: async () => 'https://ones.example.com',
    ...over,
  }) as unknown as OpenApiTokenService

describe('OpenApiClientService 韧性', () => {
  it('正常请求：携带 Bearer token，解析 JSON', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ result: 'SUCCESS' }), { status: 200 }))
    const restore = stubFetch(fetchMock)
    const client = makeClient(null, tokenServiceStub())
    const data = await client.get('project/projects', { teamID: 'T1' })
    expect(data).toEqual({ result: 'SUCCESS' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toContain('/openapi/v2/project/projects?teamID=T1')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
    restore()
  })

  it('401 一次：清除缓存后用新 token 重试成功', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"result":"SUCCESS"}', { status: 200 }))
    const restore = stubFetch(fetchMock)
    const invalidate = jest.fn()
    const client = makeClient(null, tokenServiceStub({ invalidateToken: invalidate as unknown as () => void }))
    const data = await client.get('account/teams')
    expect(data).toEqual({ result: 'SUCCESS' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
    restore()
  })

  it('连续 401：重试一次后仍失败则抛错（status 挂载）', async () => {
    const fetchMock = jest.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    const restore = stubFetch(fetchMock)
    const client = makeClient(null, tokenServiceStub())
    await expect(client.get('account/teams')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    restore()
  })

  it('403：不重试，直接抛错（scope/业务权限由调用方分类）', async () => {
    const fetchMock = jest.fn(async () => new Response('{"error":"forbidden"}', { status: 403 }))
    const restore = stubFetch(fetchMock)
    const client = makeClient(null, tokenServiceStub())
    await expect(client.get('license/apps')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    restore()
  })

  it('5xx：抛错且不静默', async () => {
    const fetchMock = jest.fn(async () => new Response('server error', { status: 500 }))
    const restore = stubFetch(fetchMock)
    const client = makeClient(null, tokenServiceStub())
    await expect(client.get('account/teams')).rejects.toMatchObject({ status: 500 })
    restore()
  })

  it('POST 请求体与 Content-Type 正确', async () => {
    const fetchMock = jest.fn(async () => new Response('{"result":"SUCCESS"}', { status: 200 }))
    const restore = stubFetch(fetchMock)
    const client = makeClient(null, tokenServiceStub())
    await client.post('project/issueFields/changeLog/query', { issue_uuids: ['a'], limit: 50 }, { teamID: 'T1' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toContain('teamID=T1')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('issue_uuids')
    restore()
  })
})

describe('CollectorsService 韧性（分页与截断）', () => {
  const { CollectorsService } = require('../services/collectors.service')

  const makeCollectors = (getImpl: (path: string, query?: Record<string, unknown>) => Promise<unknown>, postImpl?: (path: string, body: unknown, query?: Record<string, unknown>) => Promise<unknown>) => {
    const openApi = {
      get: getImpl,
      post: postImpl ?? (async () => ({})),
    }
    return new CollectorsService(openApi)
  }

  it('项目分页：hasNextPage + endCursor 驱动翻页直到结束', async () => {
    let call = 0
    const collectors = makeCollectors(async (path, query) => {
      expect(path).toBe('project/projects')
      call++
      if (call === 1) {
        return {
          data: {
            list: [{ id: 'p1', name: 'A', createTime: 1, status: 's', statusCategory: 'c', isArchive: false }],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        }
      }
      expect((query as { cursor?: string }).cursor).toBe('cursor-1')
      return {
        data: {
          list: [{ id: 'p2', name: 'B', createTime: 2, status: 's', statusCategory: 'c', isArchive: false }],
          pageInfo: { hasNextPage: false },
        },
      }
    })
    const result = await collectors.collectProjects('T1')
    expect(result.data.map(p => p.uuid)).toEqual(['p1', 'p2'])
    expect(result.errors).toEqual([])
  })

  it('项目采集失败：返回空数据 + 错误信息（局部成功语义）', async () => {
    const collectors = makeCollectors(async () => {
      throw new Error('OpenAPI 500 /project/projects: server error')
    })
    const result = await collectors.collectProjects('T1')
    expect(result.data).toEqual([])
    expect(result.errors[0]).toContain('projects')
  })

  it('Sprint 采集：单项目失败不阻塞其他项目（partial）', async () => {
    const collectors = makeCollectors(async (path: string) => {
      if (path.includes('proj-good')) {
        return { data: { list: [{ id: 's1', name: 'S1', status: 'done', startDate: 1, endDate: 2 }] } }
      }
      throw new Error('OpenAPI 404 not found')
    })
    const result = await collectors.collectSprints('T1', ['proj-bad', 'proj-good'])
    expect(result.data.map(s => s.uuid)).toEqual(['s1'])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('proj-bad')
  })

  it('changelog 截断：records_truncated 记入错误标记（10000 条上限）', async () => {
    const collectors = makeCollectors(
      async () => ({}),
      async (path: string) => {
        if (path.includes('changeLog')) {
          return {
            data: {
              records: [
                {
                  issue_uuid: 'i1',
                  records: [
                    {
                      version_uuid: 'v1',
                      create_time: 123,
                      field_uuid: 'field005',
                      field_name: '状态',
                      field_type: 'status',
                      old_value: 'todo',
                      new_value: 'done',
                      author: { uuid: 'u1', name: '张三' },
                    },
                  ],
                },
              ],
              page_info: { has_next_page: false },
              records_truncated: true,
            },
          }
        }
        return {}
      },
    )
    const result = await collectors.collectChangelogs('T1', ['i1'])
    expect(result.data.length).toBe(1)
    expect(result.errors[0]).toContain('truncated')
  })

  it('ONESQL FAIL（HTTP 200 + result=FAIL）：抛出错误而非静默空数据', async () => {
    const collectors = makeCollectors(
      async () => ({}),
      async () => ({ result: 'FAIL', error_code: 'InvalidParameter', error_msg: 'InvalidFieldUUID' }),
    )
    const result = await collectors.collectIssues('T1', { start: 0, end: 1, compareStart: 0, compareEnd: 1 })
    expect(result.data).toEqual([])
    expect(result.errors[0]).toContain('onesql FAIL')
  })
})
