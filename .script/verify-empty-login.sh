#!/usr/bin/env bash
set -euo pipefail

HARNESS="http://127.0.0.1:8790"
JSON='{"Content-Type":"application/json"}'
RESULT="true"

check() { if ! "$@"; then RESULT="false"; fi; }

# Seed a café for the negative cases.
SEED=$(curl -s -m 20 -X POST "$HARNESS/seed" -H "$JSON" -d '{"serviceMode":"counter"}')
C=$(echo "$SEED" | node -p "const s=require('fs').readFileSync(0,'utf8');JSON.parse(s).cafeId")
SLUG=$(echo "$SEED" | node -p "const s=require('fs').readFileSync(0,'utf8');JSON.parse(s).slug")

clean() { curl -s -m 10 -X POST "$HARNESS/clean" -H "$JSON" -d "{\"cafeId\":$C}" || true; }
trap clean EXIT

echo "cafeId=$C slug=$SLUG"

login() { curl -s -m 20 -w "\nHTTP %{http_code}\n" -X POST "$HARNESS/api/cafes/$SLUG/admin/login" -H "$JSON" -H "cf-connecting-ip: 198.51.99.9" -d "$1"; }

echo "=== 1. missing password {} ==="
r=$(login '{}'); echo "$r"
echo "$r" | node -p "const s=require('fs').readFileSync(0,'utf8').trim().split('\n');{status:Number(s[s.length-1]),body:JSON.parse(s[s.length-2])}" > /tmp/step1.json
check test "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/step1.json","utf8").trim()).status' = 401)"

echo "=== 2. empty string password ==="
r=$(login '{"password":""}'); echo "$r"
echo "$r" | node -p "const s=require('fs').readFileSync(0,'utf8').trim().split('\n');{status:Number(s[s.length-1]),body:JSON.parse(s[s.length-2])}" > /tmp/step2.json
check test "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/step2.json","utf8").trim()).status' = 401)"

echo "=== 3. whitespace-only password ==="
r=$(login '{"password":"   "}'); echo "$r"
echo "$r" | node -p "const s=require('fs').readFileSync(0,'utf8').trim().split('\n');{status:Number(s[s.length-1]),body:JSON.parse(s[s.length-2])}" > /tmp/step3.json
check test "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/step3.json","utf8").trim()).status' = 401)"

echo "=== 4. incorrect password ==="
r=$(login '{"password":"wrong-password"}'); echo "$r"
echo "$r" | node -p "const s=require('fs').readFileSync(0,'utf8').trim().split('\n');{status:Number(s[s.length-1]),body:JSON.parse(s[s.length-2])}" > /tmp/step4.json
check test "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/step4.json","utf8").trim()).status' = 401)"

echo "=== 5. counter before valid login ==="
COUNT_BEFORE=$(npx wrangler d1 execute corner-cup --local --command "SELECT count FROM rate_limits WHERE key='login:$C:198.51.99.9'" 2>&1 | node -p "const s=require('fs').readFileSync(0,'utf8');const m=s.match(/\"count\":(\\d+)/); m?m[1]:0")
echo "counter before valid login = $COUNT_BEFORE"

echo "=== 6. valid password ==="
r=$(login '{"password":"harness-owner-password"}'); echo "$r"
echo "$r" | node -p "const s=require('fs').readFileSync(0,'utf8').trim().split('\n');{status:Number(s[s.length-1]),body:JSON.parse(s[s.length-2])}" > /tmp/step6.json
check test "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/step6.json","utf8").trim()).status' = 200)"

echo "=== 7. counter after valid login (should still be N) ==="
COUNT_AFTER=$(npx wrangler d1 execute corner-cup --local --command "SELECT count FROM rate_limits WHERE key='login:$C:198.51.99.9'" 2>&1 | node -p "const s=require('fs').readFileSync(0,'utf8');const m=s.match(/\"count\":(\\d+)/); m?m[1]:0")
echo "counter after valid login = $COUNT_AFTER"

echo "=== 8. valid login again after reset ==="
r=$(login '{"password":"harness-owner-password"}'); echo "$r"
echo "$r" | node -p "const s=require('fs').readFileSync(0,'utf8').trim().split('\n');{status:Number(s[s.length-1]),body:JSON.parse(s[s.length-2])}" > /tmp/step8.json
check test "$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/step8.json","utf8").trim()).status' = 200)"

echo "=== summary ==="
echo "expected counters: before=1, after=4 (4 failures; valid login does not reset)"
echo "RESULT=$RESULT"
