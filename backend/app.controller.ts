import { Controller, Get, Post, HttpCode, Body, Headers, Res } from '@nestjs/common'
import type { Response } from 'express'
import { LifecycleService, type InstallCallbackPayload } from './services/lifecycle.service'
import { createWebPageURL } from './utils'

@Controller()
export class AppController {
  constructor(private readonly lifecycleService: LifecycleService) {}

  @Get('/health_check')
  healthCheck() {
    return { ok: true }
  }

  @Post('/install_cb')
  @HttpCode(200)
  installCallback(@Body() body: InstallCallbackPayload) {
    return this.lifecycleService.handleInstall(body)
  }

  @Post('/enabled_cb')
  async enabledCallback(
    @Body() body: { time_stamp?: number },
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
  ) {
    this.respondLifecycle(res, await this.lifecycleService.handleLifecycleTransition('enabled', authorization, body))
  }

  @Post('/disabled_cb')
  async disabledCallback(
    @Body() body: { time_stamp?: number },
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
  ) {
    this.respondLifecycle(res, await this.lifecycleService.handleLifecycleTransition('disabled', authorization, body))
  }

  @Post('/uninstalled_cb')
  async uninstalledCallback(
    @Body() body: { time_stamp?: number },
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
  ) {
    this.respondLifecycle(res, await this.lifecycleService.handleLifecycleTransition('uninstalled', authorization, body))
  }

  @Post('/app_setting_entries')
  @HttpCode(200)
  getCustomEntries() {
    return {
      entries: [
        {
          title: '客户价值与健康度',
          page_url: createWebPageURL('report.html'),
        },
      ],
    }
  }

  /** 前端 ONES.fetchApp 连通性与安装状态探针（M2 骨架；身份鉴权在 M3 引入） */
  @Get('/api/app-status')
  async getAppStatus() {
    const installation = await this.lifecycleService.getInstallation()
    return {
      ok: true,
      status: installation?.status ?? 'not_installed',
    }
  }

  private respondLifecycle(res: Response, result: { code: number; body: unknown }) {
    res.status(result.code).json(result.body)
  }
}
