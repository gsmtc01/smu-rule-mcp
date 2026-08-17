/**
 * tsc는 .ts만 내보내므로 SQL 스키마가 dist에 포함되지 않는다.
 * 런타임이 dist 기준으로 스키마를 찾으므로 빌드 후 함께 복사한다.
 */
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
cpSync('src/db/schema.sql', 'dist/db/schema.sql');
console.log('복사: src/db/schema.sql → dist/db/schema.sql');
