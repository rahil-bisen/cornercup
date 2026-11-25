import fs from 'node:fs';
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from '../worker/db.js';

// Keep only statements that are safe on a fresh DB (CREATE TABLE/TRIGGER/INDEX, not ALTER/UPDATE).
const freshSafeMigs = MIGRATIONS.filter(s => !/^\s*ALTER TABLE/i.test(s) && !/^\s*UPDATE\s/i.test(s));

const out = [];
out.push('-- Corner Cup staging FRESH-DB-SAFE migration SQL');
out.push('-- Target: D1 "corner-cup-staging" (ID 39a7899c-0130-4536-9570-f07b6c29b2d4)');
out.push('-- SCHEMA (final state) + non-ALTER MIGRATIONS (new tables/triggers) + POST_MIGRATIONS.');
out.push('-- Omits ALTER TABLE ADD COLUMN (already in SCHEMA) and UPDATE backfills (no-op on empty tables).');
out.push('-- Safe to run verbatim on an empty database via: wrangler d1 execute ... --file');
out.push('-- Idempotent on re-run (IF NOT EXISTS).');
out.push('');
out.push('PRAGMA foreign_keys = ON;');
out.push('');
out.push('-- ========== SCHEMA ==========');
SCHEMA.forEach((s,i)=>{out.push(`-- SCHEMA ${i+1}`);out.push(s.trim()+';');out.push('');});
out.push('-- ========== MIGRATIONS (new tables/triggers only) ==========');
freshSafeMigs.forEach((s,i)=>{out.push(`-- MIGRATION (fresh-safe)`);out.push(s.trim()+';');out.push('');});
out.push('-- ========== POST_MIGRATIONS (indexes) ==========');
POST_MIGRATIONS.forEach((s,i)=>{out.push(`-- POST_MIGRATION ${i+1}`);out.push(s.trim()+';');out.push('');});
fs.writeFileSync('staging-migrations-freshsafe.sql', out.join('\n'));
console.log('wrote staging-migrations-freshsafe.sql');
console.log('schema:', SCHEMA.length, 'fresh-safe migrations:', freshSafeMigs.length, 'post:', POST_MIGRATIONS.length);
console.log('total:', SCHEMA.length + freshSafeMigs.length + POST_MIGRATIONS.length);
console.log('omitted ALTER/UPDATE:', MIGRATIONS.length - freshSafeMigs.length);
