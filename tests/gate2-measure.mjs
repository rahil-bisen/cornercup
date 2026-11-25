import { hashPassword, verifyPassword, isArgon2Hash, passwordNeedsReset, PasswordQueueFullError } from '../worker/cafes.js';

const results = [];

// Test 1: Cold-start - first hash
results.push({ name: 'Cold-start hash', async body() {
  const start1 = Date.now();
  const hash1 = await hashPassword('test-password-1');
  const end1 = Date.now();
  return { took: end1 - start1, hash: hash1.substring(0, 40) + '...' };
}});

// Test 2: Single verify
results.push({ name: 'Single verify', async body() {
  const start2 = Date.now();
  const ok1 = await verifyPassword('test-password-1', hash1);
  const end2 = Date.now();
  return { took: end2 - start2, ok: ok1 };
}});

// Test 3: Wrong password
results.push({ name: 'Wrong password verify', async body() {
  const ok2 = await verifyPassword('wrong-password', hash1);
  return { ok: ok2 };
}});

// Test 4: isArgon2Hash
results.push({ name: 'isArgon2Hash', async body() {
  return { result: isArgon2Hash(hash1) };
}});

// Test 5: passwordNeedsReset
results.push({ name: 'passwordNeedsReset', async body() {
  return { result: passwordNeedsReset(hash1) };
}});

// Test 6: Queue test - burst with 6 concurrent (MAX_QUEUE=3, so some should fail)
results.push({ name: 'Queue burst (6 concurrent)', async body() {
  const burstResults = await Promise.all(
    Array.from({length: 6}, () => hashPassword('burst-password').then(() => 'ok').catch(e => e instanceof PasswordQueueFullError ? 'full' : 'error'))
  );
  return { ok: burstResults.filter(r => r === 'ok').length, full: burstResults.filter(r => r === 'full').length };
}});

// Test 7: Queue test - 3 concurrent (should all succeed)
results.push({ name: 'Queue burst (3 concurrent)', async body() {
  const burstResults = await Promise.all(
    Array.from({length: 3}, () => hashPassword('burst-password-2').then(() => 'ok').catch(e => e instanceof PasswordQueueFullError ? 'full' : 'error'))
  );
  return { ok: burstResults.filter(r => r === 'ok').length, full: burstResults.filter(r => r === 'full').length };
}});

// Test 8: Repeated login - second hash (already has wasm initialized)
results.push({ name: 'Repeated hash (wasm initialized)', async body() {
  const start8 = Date.now();
  const hash2 = await hashPassword('test-password-2');
  const end8 = Date.now();
  return { took: end8 - start8, hash: hash2.substring(0, 40) + '...' };
}});

// Test 9: Malformed PHC string
results.push({ name: 'Malformed PHC string', async body() {
  try {
    await verifyPassword('test', '$argon2id$v=19$m=19456,t=2,p=1$invalid');
    return { result: 'unexpected success' };
  } catch (e) {
    return { result: 'rejected', error: e instanceof Error ? e.message : String(e) };
  }
}});

// Test 10: Oversized PHC string
results.push({ name: 'Oversized PHC string', async body() {
  try {
    const oversized = '$' + 'A'.repeat(300) + '$' + 'B'.repeat(300) + '$' + 'C'.repeat(300);
    await verifyPassword('test', oversized);
    return { result: 'unexpected success' };
  } catch (e) {
    return { result: 'rejected', error: e instanceof Error ? e.message : String(e) };
  }
}});

// Run all tests sequentially
async function runTests() {
  let hash1;
  for (const test of results) {
    try {
      const result = await test.body();
      results[results.indexOf(test)].result = result;
    } catch (e) {
      results[results.indexOf(test)].error = e instanceof Error ? e.message : String(e);
    }
  }
  
  // Print summary
  console.log('=== Gate 2 Full-Worker Runtime Measurements ===\\n');
  for (const r of results) {
    console.log(`{ name: "${r.name}",`);
    if (r.result) {
      console.log(`  result: ${JSON.stringify(r.result)},`);
    }
    if (r.error) {
      console.log(`  error: ${JSON.stringify(r.error)},`);
    }
    console.log('},');
  }
  
  // Specific summaries
  console.log('\\n--- Key Metrics Summary ---\\n');
  
  // Find cold-start and repeated hash
  const coldStart = results.find(r => r.name === 'Cold-start hash');
  const repeatedHash = results.find(r => r.name === 'Repeated hash (wasm initialized)');
  if (coldStart && coldStart.result && coldStart.result.took) {
    console.log(`Cold-start hash: ${coldStart.result.took}ms`);
  }
  if (repeatedHash && repeatedHash.result && repeatedHash.result.took) {
    console.log(`Repeated hash (wasm initialized): ${repeatedHash.result.took}ms`);
  }
  
  // Queue results
  const queue6 = results.find(r => r.name === 'Queue burst (6 concurrent)');
  const queue3 = results.find(r => r.name === 'Queue burst (3 concurrent)');
  if (queue6 && queue6.result) {
    console.log(`Queue 6 concurrent: OK=${queue6.result.ok}, Full=${queue6.result.full}`);
  }
  if (queue3 && queue3.result) {
    console.log(`Queue 3 concurrent: OK=${queue3.result.ok}, Full=${queue3.result.full}`);
  }
  
  // Verification
  const verifyOk = results.find(r => r.name === 'Single verify');
  if (verifyOk && verifyOk.result) {
    console.log(`Single verify OK: ${verifyOk.result.ok}`);
  }
  
  const wrongVerify = results.find(r => r.name === 'Wrong password verify');
  if (wrongVerify && wrongVerify.result) {
    console.log(`Wrong password verify OK (should be false): ${wrongVerify.result.ok}`);
  }
  
  const argon2Check = results.find(r => r.name === 'isArgon2Hash');
  if (argon2Check && argon2Check.result) {
    console.log(`isArgon2Hash: ${argon2Check.result.result}`);
  }
  
  const needsReset = results.find(r => r.name === 'passwordNeedsReset');
  if (needsReset && needsReset.result) {
    console.log(`passwordNeedsReset: ${needsReset.result.result}`);
  }
  
  const malformed = results.find(r => r.name === 'Malformed PHC string');
  if (malformed && malformed.result) {
    console.log(`Malformed PHC: ${malformed.result.result}`);
  }
  
  const oversized = results.find(r => r.name === 'Oversized PHC string');
  if (oversized && oversized.result) {
    console.log(`Oversized PHC: ${oversized.result.result}`);
  }
}

runTests().catch(e => console.error('Fatal error:', e));