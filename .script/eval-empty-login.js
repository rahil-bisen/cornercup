import { execSync } from 'node:child_process';

const HARNESS = 'http://127.0.0.1:8790';
const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.99.9' };
const clientIp = '198.51.99.9';
let stepNo = 0;
function log(...a) { console.log(`[${++stepNo}]`, ...a); }
function step(label) { log('=== %s ===', label); }

function req(path, body, extraHeaders = {}) {
  log('network %s', path);
  const t0 = Date.now();
  return fetch(`${HARNESS}${path}`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  }).then((r) => {
    const status = r.status;
    return r.text().then((text) => {
      let bodyParsed = null;
      if (text) { try { bodyParsed = JSON.parse(text); } catch { bodyParsed = text; } }
      log('network done %s in %dms: %d %o', path, Date.now() - t0, status, bodyParsed);
      return { status, body: bodyParsed, raw: text };
    });
  }).catch((e) => {
    log('network error %s after %dms: %s', path, Date.now() - t0, e?.message || String(e));
    return { status: 0, body: { error: e?.message || String(e) }, raw: '' };
  });
}

function d1Query(sql) {
  log('d1 %s', sql.replace(/\s+/g, ' ').slice(0, 80));
  const t0 = Date.now();
  try {
    const out = execSync(
      `npx wrangler d1 execute corner-cup --local --command "${sql.replace(/"/g, '\\"').replace(/`/g, '\\`')}"`,
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10_000_000, timeout: 20_000 }
    );
    log('d1 done in %dms:\n%s', Date.now() - t0, out);
    const m = out.match(/("count":\s*)(\d+)/);
    return m ? Number(m[2]) : 0;
  } catch (e) {
    log('d1 error after %dms: %s', Date.now() - t0, e?.message || String(e));
    return -1;
  }
}

async function main() {
  try {
    step('seed');
    const seed = await req('/seed', { serviceMode: 'counter' });
    const { cafeId, slug } = seed.body || {};
    if (!cafeId || !slug) { log('seed failed', JSON.stringify(seed.body)); process.exit(1); }
    log('cafeId=%d slug=%s', cafeId, slug);

    const cases = [
      { name: 'missing password {}', body: {} },
      { name: 'empty string password', body: { password: '' } },
      { name: 'whitespace-only password', body: { password: '   ' } },
      { name: 'incorrect password', body: { password: 'wrong-password' } },
    ];
    for (const c of cases) {
      await req(`/api/cafes/${slug}/admin/login`, c.body);
    }

    const before = d1Query(`SELECT count FROM rate_limits WHERE key='login:${cafeId}:${clientIp}'`);
    step('counter BEFORE valid login');
    log('counter=%d', before);

    step('valid password');
    const ok = await req(`/api/cafes/${slug}/admin/login`, { password: 'harness-owner-password' });
    log('valid password status=%d body=%o', ok.status, ok.body);

    const after = d1Query(`SELECT count FROM rate_limits WHERE key='login:${cafeId}:${clientIp}'`);
    step('counter AFTER valid login');
    log('counter=%d (expected 4)', after);

    step('valid login again');
    const ok2 = await req(`/api/cafes/${slug}/admin/login`, { password: 'harness-owner-password' });
    log('valid login again status=%d body=%o', ok2.status, ok2.body);

    const results = [];
    results.push({ name: 'missing_password_401', pass: cases[0] && cases[0].status === 401 });
    results.push({ name: 'empty_password_401', pass: cases[1] && cases[1].status === 401 });
    results.push({ name: 'whitespace_401', pass: cases[2] && cases[2].status === 401 });
    results.push({ name: 'incorrect_401', pass: cases[3] && cases[3].status === 401 });
    results.push({ name: 'valid_200', pass: ok.status === 200 });
    results.push({ name: 'valid_again_200', pass: ok2.status === 200 });
    results.push({ name: 'counter_incremented', pass: after > before });
    results.push({ name: 'counter_expected_value', pass: after === 4 });
    results.push({ name: 'counterNotResetByValidLogin', pass: after === before + 4 });

    log('\n=== RESULTS ===');
    let allPass = true;
    for (const r of results) {
      log('%s: %s', r.name, r.pass ? 'PASS' : 'FAIL');
      if (!r.pass) allPass = false;
    }
    log('ALL PASS: %s', allPass ? 'YES' : 'NO');
  } catch (e) {
    log('FATAL', e);
    process.exit(1);
  }
}

main();
