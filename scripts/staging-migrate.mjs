import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from '../worker/db.js';

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const config = get('--config');
const dbName = get('--db');
const remote = args.includes('--remote');
const local = args.includes('--local') || !remote;

if (!config || !dbName) {
  console.error('Usage: node scripts/staging-migrate.mjs --config <wrangler.jsonc> --db <name> [--local|--remote]');
  process.exit(1);
}

const groups = [
  { name: 'SCHEMA', items: SCHEMA },
  { name: 'MIGRATIONS', items: MIGRATIONS },
  { name: 'POST_MIGRATIONS', items: POST_MIGRATIONS },
];

let total = 0, ok = 0, skipped = 0;
for (const group of groups) {
  console.log(`\n=== ${group.name} (${group.items.length}) ===`);
  for (let i = 0; i < group.items.length; i++) {
    const sql = group.items[i].trim() + ';';
    const tmp = path.join(os.tmpdir(), `stmt-${Date.now()}-${i}.sql`);
    fs.writeFileSync(tmp, sql);
    total++;
    const cliArgs = ['wrangler', 'd1', 'execute', dbName, '--config', config, '--file', tmp];
    if (remote) cliArgs.push('--remote'); else cliArgs.push('--local');
    try {
      execFileSync('npx', cliArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
      ok++;
      console.log(`  [OK]   ${group.name} ${i + 1}`);
    } catch (e) {
      const stderr = String(e.stderr || '');
      const stdout = String(e.stdout || '');
      const combined = stderr + stdout;
      const alterMatch = sql.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
      if (alterMatch && (/duplicate column/i.test(combined) || /already exists/i.test(combined))) {
        const [, table, column] = alterMatch;
        const verifyCmd = `"SELECT COUNT(*) AS cnt FROM pragma_table_info('${table}') WHERE name='${column}';"`;
        const vArgs = ['wrangler', 'd1', 'execute', dbName, '--config', config, '--command', verifyCmd];
        if (remote) vArgs.push('--remote'); else vArgs.push('--local');
        let verified = false;
        try {
          const vOut = execFileSync('npx', vArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
          if (/"cnt"\s*:\s*1/.test(vOut)) verified = true;
        } catch {}
        if (verified) {
          skipped++;
          console.log(`  [SKIP] ${group.name} ${i + 1} (duplicate column ${table}.${column}, verified present)`);
          fs.unlinkSync(tmp);
          continue;
        }
      }
      fs.unlinkSync(tmp);
      console.error(`  [FAIL] ${group.name} ${i + 1}`);
      console.error('SQL:', sql.slice(0, 200));
      console.error('ERR:', combined.slice(0, 500));
      process.exit(1);
    }
    fs.unlinkSync(tmp);
  }
}
console.log(`\nDone. total=${total} ok=${ok} skipped=${skipped}`);
