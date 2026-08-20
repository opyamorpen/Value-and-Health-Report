import { DetectorsService, buildOpportunities } from '../services/detectors.service'
import type { DetectorResult } from '../services/detectors.service'

/**
 * M5 探测器降级测试（README 实施步骤 5/7 前置）：
 * 接口漂移/失败 → 无法核验（绝不降级为未配置）；未购买旁路；增购机会生成。
 */

const makeService = (getImpl: (path: string, query?: Record<string, unknown>) => Promise<unknown>, postImpl: (path: string, body: unknown, query?: Record<string, unknown>) => Promise<unknown>) => {
  const openApi = { get: getImpl, post: postImpl }
  return new DetectorsService(openApi as never)
}

const ctx = { teamUuid: 'T1', periodStart: 1000, periodEnd: 2000 }

describe('DetectorsService 降级与旁路', () => {
  it('全部数据源失败：所有维度判「无法核验」而非「未配置」', async () => {
    const service = makeService(
      async () => {
        throw Object.assign(new Error('OpenAPI 500'), { status: 500 })
      },
      async () => {
        throw Object.assign(new Error('OpenAPI 500'), { status: 500 })
      },
    )
    const results = await service.detectAll(ctx)
    expect(results.length).toBe(12)
    for (const r of results) {
      // 全数据源失败：只允许 无法核验 或 不适用（D12 恒为旁路）
      expect(['无法核验', '不适用']).toContain(r.maturity)
    }
  })

  it('license 可达但模块未购：未购买 + 进入增购机会', async () => {
    const service = makeService(
      async (path: string) => {
        if (path === 'license/apps') {
          return { data: [{ appID: 'project', scale: 100, usage: 10 }] } // 只有 project
        }
        if (path === 'project/projects') {
          return { data: { list: [{ id: 'p1', isArchive: false }] } }
        }
        return { data: { list: [] } }
      },
      async () => ({ data: { data: [{ item: { total: 50 } }] } }),
    )
    const results = await service.detectAll(ctx)
    const test = results.find(r => r.dimension.startsWith('D4'))
    const desk = results.find(r => r.dimension.startsWith('D9'))
    expect(test?.maturity).toBe('未购买')
    expect(desk?.maturity).toBe('未购买')

    const opportunities = buildOpportunities(results)
    const modules = opportunities.map(o => o.moduleName)
    expect(modules).toContain('Test 与质量闭环')
    expect(modules).toContain('Desk 服务管理')
  })

  it('接口漂移（404/InvalidField）：schema-drift 分类 + 无法核验', async () => {
    const service = makeService(
      async (path: string) => {
        if (path === 'license/apps') {
          return { data: [{ appID: 'project' }] }
        }
        throw Object.assign(new Error('OpenAPI 404 NotFound'), { status: 404 })
      },
      async () => {
        throw new Error('OpenAPI 400: onesql FAIL InvalidFieldUUID')
      },
    )
    const results = await service.detectAll(ctx)
    const unverifiable = results.filter(r => r.maturity === '无法核验')
    expect(unverifiable.length).toBeGreaterThan(0)
    for (const r of unverifiable) {
      expect(['schema-drift', 'network', 'version']).toContain(r.failure)
    }
  })

  it('活跃数据驱动成熟度判定：D1 活跃使用', async () => {
    const service = makeService(
      async (path: string) => {
        if (path === 'license/apps') return { data: [{ appID: 'project' }] }
        if (path === 'project/projects') return { data: { list: [{ id: 'p1', isArchive: false }] } }
        return { data: { list: [] } }
      },
      async () => ({ data: { data: [{ item: { total: 50 } }] } }), // 周期内 50 个新工作项 → 活跃
    )
    const results = await service.detectAll(ctx)
    const d1 = results.find(r => r.dimension.startsWith('D1'))
    expect(d1?.maturity).toBe('活跃使用')
    expect(d1?.evidence.length).toBeGreaterThan(0)
  })

  it('零项目：D1 未配置（数据可达时的合法判定）', async () => {
    const service = makeService(
      async (path: string) => {
        if (path === 'license/apps') return { data: [{ appID: 'project' }] }
        if (path === 'project/projects') return { data: { list: [] } }
        return { data: { list: [] } }
      },
      async () => ({ data: { data: [] } }),
    )
    const results = await service.detectAll(ctx)
    const d1 = results.find(r => r.dimension.startsWith('D1'))
    expect(d1?.maturity).toBe('未配置')
  })

  it('每个探测器结果携带维度/覆盖率/证据（可追溯）', async () => {
    const service = makeService(
      async (path: string) => {
        if (path === 'license/apps') return { data: [{ appID: 'project' }] }
        return { data: { list: [] } }
      },
      async () => ({ data: { data: [] } }),
    )
    const results = await service.detectAll(ctx)
    for (const r of results) {
      expect(r.dimension).toMatch(/^D\d+/)
      expect(r.coverage).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeTruthy()
      expect(Array.isArray(r.evidence)).toBe(true)
    }
  })
})

describe('buildOpportunities', () => {
  it('仅未购买维度进入机会；已购维度不进入', () => {
    const results: DetectorResult[] = [
      { dimension: 'D4_Test 与质量闭环', maturity: '未购买', coverage: 1, confidence: 'high', lastCollectedAt: 1, evidence: [] },
      { dimension: 'D1 项目与工作项流程', maturity: '活跃使用', coverage: 1, confidence: 'high', lastCollectedAt: 1, evidence: [] },
    ]
    const opportunities = buildOpportunities(results)
    expect(opportunities.length).toBe(1)
    expect(opportunities[0].moduleKey).toContain('D4')
  })

  it('核心活跃时机会理由升级为能力扩展', () => {
    const results: DetectorResult[] = [
      { dimension: 'D4_Test 与质量闭环', maturity: '未购买', coverage: 1, confidence: 'high', lastCollectedAt: 1, evidence: [] },
      { dimension: 'D1 项目与工作项流程', maturity: '活跃使用', coverage: 1, confidence: 'high', lastCollectedAt: 1, evidence: [] },
    ]
    const opportunities = buildOpportunities(results)
    expect(opportunities[0].reason).toContain('能力扩展')
  })
})
