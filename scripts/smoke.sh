#!/usr/bin/env bash
# One end-to-end smoke run of the agent-quorum plan loop from source, on a single
# provider's cheap model. The positional selects the provider:
#
#   codex    gpt-5.5
#   claude   sonnet
#   cursor   composer-2.5
#
# All roles use the selected provider; the run is a single low-effort iteration
# with no fix or translate pass. Override the model with SMOKE_MODEL, reasoning
# with SMOKE_REASONING, the input with SMOKE_PROMPT. See the smoke-testing section
# of docs/development/agent-skill-flow.md.
set -euo pipefail

readonly DEFAULT_PROVIDER=codex
readonly DEFAULT_REASONING=low
readonly SMOKE_ROLES=(CRITIC CREATOR FIXER REVIEWER TRANSLATOR)

provider="${1:-$DEFAULT_PROVIDER}"
case "$provider" in
  codex) default_model=gpt-5.5 ;;
  claude) default_model=sonnet ;;
  cursor) default_model=composer-2.5 ;;
  *)
    echo "usage: scripts/smoke.sh [codex|claude|cursor]" >&2
    exit 2
    ;;
esac

model="${SMOKE_MODEL:-$default_model}"
reasoning="${SMOKE_REASONING:-$DEFAULT_REASONING}"
root="$(cd "$(dirname "$0")/.." && pwd)"
prompt="${SMOKE_PROMPT:-$root/scripts/smoke.plan.md}"

export AGENT_QUORUM_CLARIFY=0
export AGENT_QUORUM_RETRY_COUNT="${AGENT_QUORUM_RETRY_COUNT:-1}"
export AGENT_QUORUM_RETRY_DELAY_SECONDS="${AGENT_QUORUM_RETRY_DELAY_SECONDS:-2}"
for role in "${SMOKE_ROLES[@]}"; do
  export "AGENT_QUORUM_${role}_RUNNER=$provider"
  export "AGENT_QUORUM_${role}_MODEL=$model"
  export "AGENT_QUORUM_${role}_REASONING=$reasoning"
done

work="$root/.agents/plans/smoke-$provider"
export AGENT_QUORUM_WORK_DIR="$work"
rm -rf "$work"
echo "[smoke] provider=$provider model=$model reasoning=$reasoning"
echo "[smoke] workdir=$work"
exec pnpm run plan:self -- --prompt "$prompt" --effort low --iters 1 --no-fix --no-translate
