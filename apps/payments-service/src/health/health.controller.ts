import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  /** Liveness: процесс жив и обслуживает запросы. Не зависит от внешних систем. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: сервис готов, только если отвечает БД. */
  @Get()
  async check() {
    await this.dataSource.query('SELECT 1');
    return { status: 'ok' };
  }
}
