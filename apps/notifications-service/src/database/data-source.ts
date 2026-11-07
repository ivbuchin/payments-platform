import { DataSource } from 'typeorm';
import { loadEnv } from '../config/env';
import { buildDataSourceOptions } from './data-source-options';

/** Точка входа для `typeorm migration:*`. */
export default new DataSource(buildDataSourceOptions(loadEnv().DATABASE_URL));
