import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export interface TestApp {
  app: INestApplication;
  dataSource: DataSource;
  /** Базовый URL реально слушающего сервера: supertest не плодит слушатели на каждый запрос. */
  url: string;
  stop(): Promise<void>;
}

/** Поднимает настоящий PostgreSQL в контейнере и приложение с боевой конфигурацией и миграциями. */
export async function startTestApp(): Promise<TestApp> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(container.getConnectionUri())],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  return {
    app,
    dataSource: app.get(DataSource),
    url: await app.getUrl(),
    stop: async () => {
      await app.close();
      await container.stop();
    },
  };
}
