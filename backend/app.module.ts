import { Module } from '@nestjs/common'
import { ServeStaticModule } from '@nestjs/serve-static'
import { AppController } from './app.controller'
import { ProbeController } from './probe.controller'
import { LifecycleService } from './services/lifecycle.service'
import { OpenApiTokenService } from './services/openapi-token.service'
import { OpenApiClientService } from './services/openapi-client.service'
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
  controllers: [AppController, ProbeController],
  providers: [LifecycleService, OpenApiTokenService, OpenApiClientService],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(WebProxyMiddleware).forRoutes('*')
  }
}
