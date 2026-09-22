import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim()),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}
void bootstrap();
