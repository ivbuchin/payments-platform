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
      walletUrl: env.WALLET_URL,
      walletKeySecret: env.WALLET_KEY_SECRET,
      walletTimeoutMs: env.WALLET_TIMEOUT_MS,
      amqpUrl: env.AMQP_URL,
      reconcile: {
        intervalMs: env.RECONCILE_INTERVAL_MS,
        staleAfterMs: env.RECONCILE_STALE_AFTER_MS,
        authorizationTtlMs: env.AUTHORIZATION_TTL_MS,
      },
    }),
  );
  configureApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Payments Service')
      .setDescription('Платежи: авторизация, списание, отмена и возврат поверх wallet-service')
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`payments-service слушает :${env.PORT}, документация: /docs`);
}

void bootstrap();
