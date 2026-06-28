#!/usr/bin/env bash
# Concurrent shared-root acceptance harness for the vitest suite.
#
#   scripts/concurrent-test-check.sh [rounds] [parallel]
#
# Runs `rounds` (default 5) rounds of `parallel` (default 2) simultaneous
# `pnpm run test` invocations from the current worktree root to recreate the
# host-CPU contention that makes the timing-sensitive integration tests flake.
# Every configured round runs (no first-failure abort) and a complete
# per-(round,run) failure/timeout inventory is aggregated and printed.
#
# Each run is bounded by AQ_RUN_TIMEOUT_SECS (default 600): a run still alive at
# the deadline is recorded as `timed-out (hang)` and its process group killed,
# instead of blocking the harness forever. An EXIT/INT/TERM trap signals and
# reaps every still-tracked process group -- not just the parent pnpm PID -- so
# an interrupted harness never leaves orphaned pnpm/vitest/worker processes.
#
# Exits non-zero if any run failed or timed out; otherwise prints
# `<rounds> rounds x <parallel> runs: all green` and exits 0. It invokes
# `pnpm run test` (coverage-free, package.json) and never the build, so the
# dist/ build-output race cannot confound the measurement.
#
# darwin / bash 3.2 portability: setsid and GNU timeout are unavailable, so each
# run becomes its own process-group leader via job control (`set -m`, PGID == job
# PID) and per-run deadlines come from bash `SECONDS`. Run completion is signalled
# by a per-run sentinel rc file rather than `kill -0` alone, which on an
# exited-but-unwaited child can read as still-alive (zombie). No associative
# arrays or `wait -n` (bash 4+).

set -uo pipefail
set -m

ROUNDS="${1:-5}"
PARALLEL="${2:-2}"
RUN_TIMEOUT_SECS="${AQ_RUN_TIMEOUT_SECS:-600}"
KILL_GRACE_SECS="${AQ_KILL_GRACE_SECS:-5}"

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aq-concurrent.XXXXXX")"
ACTIVE_PIDS=()
INVENTORY=()
ANY_FAILED=0
ANY_TIMED_OUT=0

kill_group() {
  # TERM the whole process group, give it a bounded grace, then KILL and reap.
  local pid="$1" g=0
  kill -TERM "-$pid" 2>/dev/null || true
  while (( g < KILL_GRACE_SECS )); do
    kill -0 "-$pid" 2>/dev/null || break
    sleep 1
    g=$(( g + 1 ))
  done
  kill -KILL "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  # Reap every still-tracked run's full process group on any exit path. Killing
  # an already-dead group is a harmless no-op, so this is safe to run once via
  # the EXIT trap even when an INT/TERM handler triggered the exit. Per-run logs
  # are left in place so a partial inventory stays readable.
  if (( ${#ACTIVE_PIDS[@]} > 0 )); then
    local pid
    for pid in "${ACTIVE_PIDS[@]}"; do
      [[ -n "$pid" ]] || continue
      kill_group "$pid"
    done
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'concurrent-test-check: %s rounds x %s runs, per-run timeout %ss, kill grace %ss\n' \
  "$ROUNDS" "$PARALLEL" "$RUN_TIMEOUT_SECS" "$KILL_GRACE_SECS"
printf 'worktree root: %s\n' "$(pwd)"
printf 'log dir: %s\n' "$LOG_DIR"

round=1
while (( round <= ROUNDS )); do
  printf '\n=== round %s/%s ===\n' "$round" "$ROUNDS"
  ACTIVE_PIDS=()
  RUN_LOG=()
  RUN_RC=()

  n=1
  while (( n <= PARALLEL )); do
    log="$LOG_DIR/round-$round-run-$n.log"
    rcf="$LOG_DIR/round-$round-run-$n.rc"
    rm -f "$rcf"
    # Own process group (set -m) so the whole pnpm -> vitest -> workers tree can
    # be signalled together; sentinel rc file records completion.
    ( pnpm run test >"$log" 2>&1; echo $? >"$rcf" ) &
    pid=$!
    ACTIVE_PIDS[$n]=$pid
    RUN_LOG[$n]=$log
    RUN_RC[$n]=$rcf
    printf 'launched round %s run %s: pgid=%s log=%s\n' "$round" "$n" "$pid" "$log"
    n=$(( n + 1 ))
  done

  n=1
  while (( n <= PARALLEL )); do
    pid="${ACTIVE_PIDS[$n]}"
    rcf="${RUN_RC[$n]}"
    log="${RUN_LOG[$n]}"
    deadline=$(( SECONDS + RUN_TIMEOUT_SECS ))
    while (( SECONDS < deadline )); do
      [[ -f "$rcf" ]] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done

    if [[ -f "$rcf" ]]; then
      rc="$(cat "$rcf" 2>/dev/null || echo 1)"
      wait "$pid" 2>/dev/null || true
      unset 'ACTIVE_PIDS[n]'
      if [[ "$rc" == "0" ]]; then
        printf 'round %s run %s: ok\n' "$round" "$n"
      else
        ANY_FAILED=1
        fails="$(grep -E '^[[:space:]]*FAIL[[:space:]]' "$log" 2>/dev/null | sed -e 's/^[[:space:]]*//' || true)"
        [[ -n "$fails" ]] || fails="$(grep -E '[0-9]+ failed' "$log" 2>/dev/null | head -3 | sed -e 's/^[[:space:]]*//' || true)"
        [[ -n "$fails" ]] || fails="(rc=$rc; no FAIL lines parsed; see log)"
        while IFS= read -r fline; do
          [[ -n "$fline" ]] || continue
          INVENTORY[${#INVENTORY[@]}]="round $round run $n: $fline | $log"
        done <<INVEOF
$fails
INVEOF
        printf 'round %s run %s: FAILED (rc=%s)\n' "$round" "$n" "$rc"
      fi
    else
      # No rc written within the deadline: a hung run. Kill its group and record
      # it as timed-out (a STOP trigger at the default, non-injected timeout).
      ANY_TIMED_OUT=1
      printf 'round %s run %s: TIMED-OUT (hang) after %ss -> killing pgid %s\n' \
        "$round" "$n" "$RUN_TIMEOUT_SECS" "$pid"
      kill_group "$pid"
      unset 'ACTIVE_PIDS[n]'
      INVENTORY[${#INVENTORY[@]}]="round $round run $n: TIMED-OUT (hang) after ${RUN_TIMEOUT_SECS}s | $log"
    fi
    n=$(( n + 1 ))
  done
  ACTIVE_PIDS=()
  round=$(( round + 1 ))
done

printf '\n=== summary ===\n'
if (( ANY_FAILED == 0 && ANY_TIMED_OUT == 0 )); then
  printf '%s rounds x %s runs: all green\n' "$ROUNDS" "$PARALLEL"
  rm -rf "$LOG_DIR"
  exit 0
fi

printf 'failures/timeouts (%s):\n' "${#INVENTORY[@]}"
if (( ${#INVENTORY[@]} > 0 )); then
  for entry in "${INVENTORY[@]}"; do
    printf '  - %s\n' "$entry"
  done
fi
printf 'logs preserved under: %s\n' "$LOG_DIR"
if (( ANY_TIMED_OUT == 1 )); then
  printf 'NOTE: a run timed out (hang); at the default AQ_RUN_TIMEOUT_SECS this is a STOP trigger\n'
fi
exit 1
