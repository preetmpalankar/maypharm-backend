import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config';

async function bootstrap() {
  // Validate configuration before Nest builds anything, so a missing variable
  // fails the deploy with a clear message instead of a stack trace.
  const config = loadConfig();
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: config.isProduction
      ? ['log', 'warn', 'error']
      : ['log', 'warn', 'error', 'debug'],
  });

  configureApp(app, config);

  await app.listen(config.PORT, config.HOST);
  logger.log(
    `MayPharm API listening on ${config.HOST}:${config.PORT} (${config.NODE_ENV})`,
  );
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist if configuration failed; write straight to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
