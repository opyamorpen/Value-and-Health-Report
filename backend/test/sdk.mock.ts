/**
 * @ones-open/node-sdk 测试替身：实体存储用内存 Map 模拟（含 key 校验与 value 包装结构），
 * oauth 返回固定 token。与 M2 实测行为一致（entity key 正则、getMany 返回 {data:[{key,value}]}）。
 */
type EntityRow = { key: string; value: Record<string, unknown> }

const KEY_PATTERN = /^[_a-z0-9]{1,64}$/

const createEntity = (name: string) => {
  const store = new Map<string, Record<string, unknown>>()
  return {
    _name: name,
    async get(key: string): Promise<Record<string, unknown> | undefined> {
      if (!KEY_PATTERN.test(key)) {
        const err = new Error('The provided data key does not match the regex') as Error & { code: string }
        err.code = 'EntityDataKeyInvalid'
        throw err
      }
      return store.get(key)
    },
    async set(key: string, value: Record<string, unknown>): Promise<void> {
      if (!KEY_PATTERN.test(key)) {
        const err = new Error('The provided data key does not match the regex') as Error & { code: string }
        err.code = 'EntityDataKeyInvalid'
        throw err
      }
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
    async query(): Promise<{ getMany(): Promise<{ page_info: object; data: EntityRow[] }> }> {
      return {
        getMany: async () => ({
          page_info: { count: store.size, has_more: false },
          data: [...store.entries()].map(([key, value]) => ({ key, value })),
        }),
      }
    },
  }
}

export const storage = {
  entity: <T extends Record<string, unknown>>(name: string) => createEntity(name) as unknown as {
    get(key: string): Promise<T | undefined>
    set(key: string, value: Partial<T>): Promise<void>
    delete(key: string): Promise<void>
    query(): { getMany(): Promise<{ page_info: object; data: Array<{ key: string; value: T }> }> }
  },
  object: {
    upload: jest.fn(async () => ({
      getUrl: () => 'http://internal/upload',
      getWebUrl: () => 'https://example.com/upload',
      getFields: () => ({ key: 'value', Policy: 'p' }),
    })),
    download: jest.fn(async () => ({
      getUrl: () => 'http://internal/download',
      getWebUrl: () => 'https://example.com/download',
    })),
    delete: jest.fn(async () => undefined),
  },
}

export const oauth = {
  getAccessTokenByInstallationInfo: jest.fn(async () => 'test-access-token'),
}
