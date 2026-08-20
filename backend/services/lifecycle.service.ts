import { createHmac } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { storage } from '@ones-open/node-sdk'

export type LifecycleStatus = 'installed' | 'enabled' | 'disabled' | 'uninstalled'

export type InstallationInfoEntity = {
  installation_id: string
  shared_secret: string
  ones_base_url: string
  status: LifecycleStatus
  time_stamp: number
  updated_at: number
}

export type InstallCallbackPayload = {
  installation_id: string
  shared_secret: string
  ones_base_url: string
  time_stamp?: number
}

const installationInfo = storage.entity<InstallationInfoEntity>('installation_info')

/** entity key 仅允许 [_a-z0-9]{1,64}：安装 ID 统一规范化（小写 + 非法字符转 _） */
const toEntityKey = (installationId: string): string =>
  installationId.toLowerCase().replace(/[^_a-z0-9]/g, '_').slice(0, 64)

/** JWT 声明（生命周期回调 Authorization: Bearer <jwt>） */
export type LifecycleJwt = {
  iss?: string
  sub: string
  aud: string | string[]
  iat: number
  exp: number
  [key: string]: unknown
}

const APP_ID = 'app_09b374c462ec4d64'
/** 生命周期乱序/重放容忍窗口：7 天（毫秒） */
const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name)

  async getInstallation(): Promise<InstallationInfoEntity | undefined> {
    const result = (await installationInfo.query().getMany()) as unknown
    const rows =
      (Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])) as Array<
        InstallationInfoEntity & { value?: InstallationInfoEntity }
      >
    return rows[0]?.value ?? rows[0]
  }

  /** install 回调：无 Authorization 头，10s 内必须 200，重试仅 1 次 */
  async handleInstall(payload: InstallCallbackPayload): Promise<{ ok: boolean; error?: string }> {
    const installationId = (payload.installation_id || '').trim()
    const sharedSecret = (payload.shared_secret || '').trim()
    const onesBaseUrl = (payload.ones_base_url || '').trim()
    if (!installationId || !sharedSecret || !onesBaseUrl) {
      return { ok: false, error: 'invalid install callback payload' }
    }

    try {
      // 幂等：重复 install 直接覆盖（install 供应新密钥，原子轮换）
      await installationInfo.set(toEntityKey(installationId), {
        installation_id: installationId,
        shared_secret: sharedSecret,
        ones_base_url: onesBaseUrl,
        status: 'installed',
        time_stamp: payload.time_stamp ?? Date.now(),
        updated_at: Date.now(),
      })
      return { ok: true }
    } catch (error) {
      this.logger.error(
        `install-callback: failed to save installation info: code=${(error as { code?: string }).code} message=${String((error as { err_msg?: string }).err_msg ?? (error as Error).message)}`,
      )
      return { ok: false, error: 'failed to save install callback data' }
    }
  }

  /**
   * enabled/disabled/uninstalled 回调：携带 JWT。
   * 校验失败返回 401；乱序（time_stamp 比已记录旧）幂等忽略；重复回调幂等返回成功。
   */
  async handleLifecycleTransition(
    status: Exclude<LifecycleStatus, 'installed'>,
    authorizationHeader: string | undefined,
    payload: { time_stamp?: number },
  ): Promise<{ code: number; body: { ok: boolean; ignored?: boolean; error?: string } }> {
    const installation = await this.getInstallation()
    if (!installation) {
      return { code: 401, body: { ok: false, error: 'installation not found' } }
    }

    const token = this.extractBearerToken(authorizationHeader)
    if (!token) {
      return { code: 401, body: { ok: false, error: 'missing bearer token' } }
    }

    let claims: LifecycleJwt
    try {
      claims = this.verifyJwt(token, installation.shared_secret, installation.installation_id)
    } catch (error) {
      return { code: 401, body: { ok: false, error: (error as Error).message } }
    }

    const incomingStamp = this.resolveTimeStamp(payload, claims)
    // 乱序/重放：比已记录的 time_stamp 旧（超出容忍窗口）则忽略，返回成功（不阻塞 ONES 生命周期）
    if (installation.time_stamp - incomingStamp > STALE_WINDOW_MS) {
      return { code: 200, body: { ok: true, ignored: true } }
    }

    const isReplay = installation.status === status && installation.time_stamp === incomingStamp
    if (!isReplay) {
      await installationInfo.set(toEntityKey(installation.installation_id), {
        ...installation,
        status,
        time_stamp: incomingStamp,
        updated_at: Date.now(),
      })
    }
    return { code: 200, body: { ok: true, ignored: isReplay } }
  }

  private extractBearerToken(header: string | undefined): string | undefined {
    if (!header || !header.startsWith('Bearer ')) {
      return undefined
    }
    return header.slice('Bearer '.length).trim() || undefined
  }

  /** HS256 + 声明校验；密钥为 base64 编码的 shared_secret，签名时使用解码后的原始字节 */
  private verifyJwt(token: string, base64Secret: string, installationId: string): LifecycleJwt {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new Error('malformed jwt')
    }
    const [header, payload, signature] = parts

    let decodedHeader: { alg?: string }
    try {
      decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
    } catch {
      throw new Error('malformed jwt header')
    }
    if (decodedHeader.alg !== 'HS256') {
      throw new Error('unexpected jwt alg')
    }

    const expected = createHmac('sha256', Buffer.from(base64Secret, 'base64'))
      .update(`${header}.${payload}`)
      .digest('base64url')
    if (expected !== signature) {
      throw new Error('jwt signature mismatch')
    }

    let claims: LifecycleJwt
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      throw new Error('malformed jwt payload')
    }

    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(APP_ID)) {
      throw new Error('jwt aud mismatch')
    }
    if (claims.sub !== installationId) {
      throw new Error('jwt sub mismatch')
    }
    const now = Math.floor(Date.now() / 1000)
    if (typeof claims.exp !== 'number' || claims.exp < now) {
      throw new Error('jwt expired')
    }
    return claims
  }

  private resolveTimeStamp(payload: { time_stamp?: number }, claims: LifecycleJwt): number {
    const fromPayload = typeof payload.time_stamp === 'number' ? payload.time_stamp : 0
    const fromClaims = typeof claims.time_stamp === 'number' ? claims.time_stamp : 0
    return fromPayload || fromClaims || Date.now()
  }
}
