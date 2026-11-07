import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: env.DATABASE_URL,
      amqpUrl: env.AMQP_URL,
      allowPrivateWebhookTargets: env.ALLOW_PRIVATE_WEBHOOK_TARGETS,
      delivery: {
        maxAttempts: env.DELIVERY_MAX_ATTEMPTS,
        baseDelayMs: env.DELIVERY_BASE_DELAY_MS,
        maxDelayMs: env.DELIVERY_MAX_DELAY_MS,
        timeoutMs: env.DELIVERY_TIMEOUT_MS,
        batchSize: 20,
        leaseMs: 60_000,
        pollIntervalMs: 500,
        autoStart: true,
      },
    }),
  );
  configureApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Notifications Service')
      .setDescription('Подписки на события платформы и надёжная доставка подписанных вебхуков')
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`notifications-service слушает :${env.PORT}, документация: /docs`);
}

void bootstrap();
