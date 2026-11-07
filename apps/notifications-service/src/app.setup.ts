import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Общая настройка приложения для main.ts и e2e-тестов — тесты проверяют ту же конфигурацию. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
}
