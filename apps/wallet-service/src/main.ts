import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule.forRoot(env.DATABASE_URL, env.AMQP_URL));
  configureApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Wallet Service')
      .setDescription('Счета, переводы и холды с двойной записью')
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`wallet-service слушает :${env.PORT}, документация: /docs`);
}

void bootstrap();
