import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { getHostedPort } from './utils'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  const configuredPort = getHostedPort()
  await app.listen(configuredPort)

  const address = app.getHttpServer().address()
  const currentPort =
    typeof address === 'string' ? configuredPort : (address?.port ?? configuredPort)
  console.log(`App server is listening on port ${currentPort}`)
}
bootstrap().catch(console.error)
