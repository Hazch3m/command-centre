#!/usr/bin/env bash
# Runs a build step; on failure, publishes the relevant part of its output as a
# single GitHub annotation (readable through the API even when raw logs aren't).
name="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  # Prefer compiler/test error blocks; fall back to the tail of the log.
  body="$(grep -E -A12 '^(error|warning: unused)|error\[E|FAIL|Error:|panicked|failed' "$log" | head -c 60000)"
  [ -z "$body" ] && body="$(tail -n 150 "$log")"
  body="${body//'%'/'%25'}"; body="${body//$'\r'/}"; body="${body//$'\n'/'%0A'}"
  echo "::error title=${name} failed::${body}"
fi
exit "$code"
