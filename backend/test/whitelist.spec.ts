import { WhitelistGuard, WhitelistService } from '../services/whitelist.service'
import type { ExecutionContext } from '@nestjs/common'

/**
 * M6 越权测试（README 实施步骤 8 前置）：
 * 非白名单 403、缺身份参数 401、白名单成员（非 admin）不能改白名单。
 */

const makeContext = (query: Record<string, string>, body: Record<string, string>): ExecutionContext => {
  const request = { query, body } as { query: Record<string, string>; body: Record<string, string>; whitelistUser?: unknown }
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext
}

describe('WhitelistGuard', () => {
  const guard = new WhitelistGuard()
  const service = new WhitelistService()

  beforeAll(async () => {
    await service.add('T1', 'adminUser1', 'admin', 'installer')
    await service.add('T1', 'memberUser', 'member', 'installer')
  })

  it('缺身份参数（teamID/userID）：401', async () => {
    await expect(guard.canActivate(makeContext({}, {}))).rejects.toMatchObject({ status: 401 })
  })

  it('非白名单用户：403（含伪造 uuid）', async () => {
    await expect(guard.canActivate(makeContext({ teamID: 'T1', userID: 'attacker' }, {}))).rejects.toMatchObject({
      status: 403,
    })
  })

  it('白名单用户：放行并注入上下文', async () => {
    const ctx = makeContext({ teamID: 'T1', userID: 'memberUser' }, {})
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    const request = (ctx.switchToHttp().getRequest() as unknown as { whitelistUser?: unknown }).whitelistUser
    expect(request).toEqual({ teamUuid: 'T1', userUuid: 'memberUser', role: 'member' })
  })

  it('跨团队白名单不通用（T1 的用户不能访问 T2）', async () => {
    await service.add('T2', 'otherUser', 'admin', 'installer')
    await expect(guard.canActivate(makeContext({ teamID: 'T2', userID: 'adminUser1' }, {}))).rejects.toMatchObject({
      status: 403,
    })
  })

  it('空团队引导：首个调用者自动成为 admin', async () => {
    const ctx = makeContext({ teamID: 'T9-fresh', userID: 'firstUser' }, {})
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    const request = (ctx.switchToHttp().getRequest() as unknown as { whitelistUser?: { role?: string } }).whitelistUser
    expect(request?.role).toBe('admin')
  })
})

describe('WhitelistService', () => {
  const service = new WhitelistService()

  it('add/list/remove 完整生命周期', async () => {
    await service.add('T3', 'u1', 'admin', 'installer')
    const list = await service.list('T3')
    expect(list).toEqual([expect.objectContaining({ userUuid: 'u1', role: 'admin' })])
    await service.remove('T3', 'u1')
    expect(await service.list('T3')).toEqual([])
  })

  it('非法 user_uuid 拒绝（防注入 entity key）', async () => {
    await expect(service.add('T3', 'bad uuid!', 'admin', 'x')).rejects.toThrow('invalid user_uuid')
  })

  it('重复 add 覆盖（幂等）', async () => {
    await service.add('T4', 'u1', 'member', 'a')
    await service.add('T4', 'u1', 'admin', 'a')
    const list = await service.list('T4')
    expect(list[0].role).toBe('admin')
  })
})
