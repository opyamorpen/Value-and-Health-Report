import { Injectable } from '@nestjs/common'
import { OpenApiTokenService } from './openapi-token.service'

/**
 * OpenAPI 客户端：App Identity token + 直连 <ones_base_url>/openapi/v2/...。
 * 统一处理分页、401 刷新重试（一次）、错误分类（401 token / 403 scope / 403 业务权限）。
 */
@Injectable()
export class OpenApiClientService {
  constructor(private readonly tokenService: OpenApiTokenService) {}

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const baseUrl = await this.tokenService.getOnesBaseUrl()
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/openapi/v2/${path.replace(/^\//, '')}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
    return this.request<T>(url)
  }

  async post<T>(path: string, body: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const baseUrl = await this.tokenService.getOnesBaseUrl()
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/openapi/v2/${path.replace(/^\//, '')}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
    return this.request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  private async request<T>(url: URL, init?: RequestInit): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      const token = await this.tokenService.getAppAccessToken()
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
      if (init?.headers) {
        Object.assign(headers, init.headers)
      }
      return fetch(url, { ...init, headers })
    }

    let response = await doFetch()
    if (response.status === 401) {
      // token 过期：失效缓存后重试一次
      this.tokenService.invalidateToken()
      response = await doFetch()
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const error = new Error(`OpenAPI ${response.status} ${url.pathname}: ${text.slice(0, 200)}`) as Error & {
        status: number
      }
      error.status = response.status
      throw error
    }
    return (await response.json()) as T
  }
}
