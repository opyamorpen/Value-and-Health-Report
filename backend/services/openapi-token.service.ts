import { Injectable } from '@nestjs/common'
import { oauth } from '@ones-open/node-sdk'
import { LifecycleService, type InstallationInfoEntity } from './lifecycle.service'

/**
 * OpenAPI App Identity token 服务。
 * 缓存 token，过期前 60s 刷新；安装密钥更新（原子轮换）后旧 token 立即失效重建。
 */
@Injectable()
export class OpenApiTokenService {
  private cachedToken: { token: string; expiresAt: number } | undefined

  constructor(private readonly lifecycleService: LifecycleService) {}

  async getAppAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.token
    }
    const installation = await this.requireInstallation()
    const token = await oauth.getAccessTokenByInstallationInfo(
      {
        installation_id: installation.installation_id,
        shared_secret: installation.shared_secret,
        ones_base_url: installation.ones_base_url,
      },
      '',
    )
    this.cachedToken = { token, expiresAt: Date.now() + 10 * 60_000 }
    return token
  }

  /** 401 时清除缓存强制刷新（调用方重试一次） */
  invalidateToken(): void {
    this.cachedToken = undefined
  }

  /** 用户委托 token（T2 验证：内部接口可能要求用户身份） */
  async getUserAccessToken(userID: string): Promise<string> {
    const installation = await this.requireInstallation()
    return oauth.getAccessTokenByInstallationInfo(
      {
        installation_id: installation.installation_id,
        shared_secret: installation.shared_secret,
        ones_base_url: installation.ones_base_url,
      },
      userID,
    )
  }

  async getOnesBaseUrl(): Promise<string> {
    return (await this.requireInstallation()).ones_base_url
  }

  private async requireInstallation(): Promise<InstallationInfoEntity> {
    const installation = await this.lifecycleService.getInstallation()
    if (!installation) {
      throw new Error('installation info not found')
    }
    return installation
  }
}
