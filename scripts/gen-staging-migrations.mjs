import fs from 'node:fs';
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from '../worker/db.js';

const out = [];
out.push('-- Corner Cup staging migration SQL');
out.push('-- Target: D1 database "corner-cup-staging" (ID 39a7899c-0130-4536-9570-f07b6c29b2d4)');
out.push('-- Generated from worker/db.js: SCHEMA, MIGRATIONS, POST_MIGRATIONS');
out.push('-- Do NOT run against production. For initial staging setup only.');
out.push('-- Idempotency: CREATE ... IF NOT EXISTS and tolerated duplicate-column ALTERs are handled by ensureDb() at runtime; raw re-execution of ALTER on existing columns will error.');
out.push('');
out.push('PRAGMA foreign_keys = ON;');
out.push('');
out.push('-- ========== SCHEMA (base tables) ==========');
SCHEMA.forEach((s, i) => { out.push(`-- SCHEMA ${i + 1}`); out.push(s.trim() + ';'); out.push(''); });
out.push('-- ========== MIGRATIONS (additive) ==========');
MIGRATIONS.forEach((s, i) => { out.push(`-- MIGRATION ${i + 1}`); out.push(s.trim() + ';'); out.push(''); });
out.push('-- ========== POST_MIGRATIONS (indexes) ==========');
POST_MIGRATIONS.forEach((s, i) => { out.push(`-- POST_MIGRATION ${i + 1}`); out.push(s.trim() + ';'); out.push(''); });

fs.writeFileSync('staging-migrations.sql', out.join('\n'));
console.log('wrote staging-migrations.sql');
console.log('SCHEMA:', SCHEMA.length, 'MIGRATIONS:', MIGRATIONS.length, 'POST_MIGRATIONS:', POST_MIGRATIONS.length);
console.log('total statements:', SCHEMA.length + MIGRATIONS.length + POST_MIGRATIONS.length);
