import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { requestContext } from './common/request-context';
import type { AppConfig } from './config';

/**
 * Everything that shapes the HTTP surface, shared by main.ts and the e2e
 * tests so they exercise exactly what production runs. The app must be
 * created with `bodyParser: false`; parsers are registered here.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig) {
  // Railway terminates TLS at its proxy; trust exactly one hop for client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );
  // Files never pass through the API (they go straight to Storage), so request
  // bodies are small JSON documents.
  app.useBodyParser('json', { limit: '256kb' });
  app.useBodyParser('urlencoded', { limit: '64kb', extended: false });

  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'range', 'x-request-id'],
    exposedHeaders: [
      'content-range',
      'content-length',
      'accept-ranges',
      'x-request-id',
    ],
    credentials: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  return app;
}
