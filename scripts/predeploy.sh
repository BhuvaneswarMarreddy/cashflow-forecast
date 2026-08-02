#!/bin/sh
# Deploy gate: block anything that type-fails, test-fails, contains a react-hooks
# crash-class violation, or fails to boot locally. Pre-existing style errors do NOT
# block; crashes do.
set -e

echo "gate 1/6: tsc"
npx tsc --noEmit

echo "gate 2/6: jest (incl. CSV audit replay)"
npm test > /tmp/predeploy_jest.log 2>&1 || { tail -25 /tmp/predeploy_jest.log; echo "BLOCKED: tests failed"; exit 1; }
grep -E "Tests:" /tmp/predeploy_jest.log

# OPS-CI-001: the Functions and Python suites used to sit outside the deploy gate.
echo "gate 3/6: jest (firebase functions)"
npm test --prefix functions > /tmp/predeploy_fnjest.log 2>&1 || { tail -25 /tmp/predeploy_fnjest.log; echo "BLOCKED: functions tests failed"; exit 1; }
grep -E "Tests:" /tmp/predeploy_fnjest.log

echo "gate 4/6: python sync tests (functions-sync)"
# Prefer pytest when it is installed; fall back to the stdlib runner so the gate
# never demands a pip install. Either way a failing test exits non-zero (set -e).
if python3 -c 'import pytest' 2>/dev/null; then
  python3 -m pytest functions-sync -q
else
  python3 -m unittest discover -s functions-sync
fi

echo "gate 5/6: react-hooks crash rules"
# Use JSON (not --format compact, which omits ruleId — that blind spot shipped a
# conditional-hook #310 crash to prod). Count any react-hooks/* message.
npx eslint src --format json > /tmp/predeploy_eslint.json 2>/dev/null || true
HOOKS=$(node -e '
  const CRASH = ["react-hooks/rules-of-hooks", "react-hooks/set-state-in-effect"];
  const r = require("/tmp/predeploy_eslint.json");
  const hits = r.flatMap(f => (f.messages||[])
    .filter(m => CRASH.includes(m.ruleId))
    .map(m => `${f.filePath.split("/").slice(-2).join("/")}:${m.line} ${m.ruleId}`));
  if (hits.length) { console.error(hits.join("\n")); }
  process.stdout.write(String(hits.length));
')
if [ "$HOOKS" != "0" ]; then
  echo "BLOCKED: $HOOKS react-hooks crash-class violation(s) above"
  exit 1
fi

# NOTE: this gate boots the app against the REAL Firebase backend (production is also
# the development project). That is why the CI workflow does NOT run this script — see
# docs/ci/VALIDATION-PIPELINE.md. Keep this gate local-only.
echo "gate 6/6: local boot smoke (real backend)"
npm run build > /tmp/predeploy_build.log 2>&1 || { tail -25 /tmp/predeploy_build.log; echo "BLOCKED: build failed"; exit 1; }
npm run start > /tmp/predeploy_server.log 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
# wait for the server, then smoke the key routes (same Firebase backend the app uses)
ok=0
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:3000/"; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { tail -25 /tmp/predeploy_server.log; echo "BLOCKED: server did not start"; exit 1; }
for route in / /login /accounts /flow /forecast /history /cashflow; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$route")
  echo "  $route -> $code"
  case "$code" in 200|307|308) ;; *) echo "BLOCKED: $route returned $code"; exit 1;; esac
done
kill $SRV 2>/dev/null || true; trap - EXIT

echo "predeploy gate: PASS"
