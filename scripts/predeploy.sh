#!/bin/sh
# Deploy gate: block anything that type-fails, test-fails, or contains a
# react-hooks crash-class violation (a conditional hook shipped a white-screen
# once — never again). Pre-existing style errors do NOT block; crashes do.
set -e
echo "gate 1/3: tsc"
npx tsc --noEmit
echo "gate 2/3: jest (incl. CSV audit replay)"
# no pipe here: POSIX sh reports the LAST command of a pipeline, which would
# let a jest failure sail through
npm test > /tmp/predeploy_jest.log 2>&1 || { tail -25 /tmp/predeploy_jest.log; echo "BLOCKED: tests failed"; exit 1; }
grep -E "Tests:" /tmp/predeploy_jest.log
echo "gate 3/3: react-hooks crash rules"
HOOKS=$(npx eslint src --format compact 2>/dev/null | grep -c "react-hooks/rules-of-hooks\|react-hooks/set-state-in-effect" || true)
if [ "$HOOKS" -gt 0 ]; then
  echo "BLOCKED: $HOOKS react-hooks crash-class violation(s):"
  npx eslint src --format compact | grep "react-hooks/rules-of-hooks\|react-hooks/set-state-in-effect"
  exit 1
fi
echo "predeploy gate: PASS"
