import { Module } from '@nestjs/common'
import { ServeStaticModule } from '@nestjs/serve-static'
import { AppController } from './app.controller'
import { ProbeController } from './probe.controller'
import { ReportsApiController } from './reports.controller'
import { LifecycleService } from './services/lifecycle.service'
import { OpenApiTokenService } from './services/openapi-token.service'
import { OpenApiClientService } from './services/openapi-client.service'
import { CollectorsService } from './services/collectors.service'
import { MetricsService } from './services/metrics.service'
import { JobsService } from './services/jobs.service'
import { ReportsService } from './services/reports.service'
import { AuditService } from './services/audit.service'
import { PdfService } from './services/pdf.service'
import { DetectorsService } from './services/detectors.service'
import { WhitelistGuard, WhitelistService } from './services/whitelist.service'
import { WebProxyMiddleware } from './proxy'
import { getPublicPath, createPublicURL, getWebPath, createWebURL, isProd } from './utils'
import type { MiddlewareConsumer } from '@nestjs/common'

const imports = [
  ServeStaticModule.forRoot({
    rootPath: getPublicPath(),
    serveRoot: createPublicURL(''),
  }),
]

if (isProd()) {
  imports.push(
    ServeStaticModule.forRoot({
      rootPath: getWebPath(),
      serveRoot: createWebURL(''),
    }),
  )
}
@Module({
  imports,
  controllers: [AppController, ProbeController, ReportsApiController],
  providers: [
    LifecycleService,
    OpenApiTokenService,
    OpenApiClientService,
    CollectorsService,
    MetricsService,
    JobsService,
    ReportsService,
    AuditService,
    PdfService,
    DetectorsService,
    WhitelistService,
    WhitelistGuard,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(WebProxyMiddleware).forRoutes('*')
  }
}
