#!/usr/bin/env bash
# Session worktree lifecycle for agent-quorum. Each subcommand keeps a session's
# work in its own linked git worktree on a session/<slug> branch so the unmodified
# pre-commit hook (git add -u + pnpm run check) operates only on that tree.
#
#   create <slug> (--desc <text> | --desc-file <path>) [--from <ref>]
#   list
#   touch <slug|path|branch>
#   release <slug|path|branch> [--into <ref>]
#
# Two durable carriers live in each worktree's git admin dir (outside any working
# tree, pruned when the worktree is removed): a task description (agent-quorum-task.md)
# and a TTL-stamped active-edit marker (agent-quorum-active-edit.json).
set -euo pipefail

readonly ACTIVE_EDIT_TTL_SECONDS=900
readonly DEFAULT_REF="main"
readonly RECORD_FILE="agent-quorum-task.md"
readonly MARKER_FILE="agent-quorum-active-edit.json"

root="$(cd "$(dirname "$0")/.." && pwd)"

worktree_storage_root() {
  echo "${AGENT_QUORUM_WORKTREE_DIR:-$HOME/.agent-quorum/worktrees}/agent-quorum"
}

session_branch_for_slug() {
  echo "session/$1"
}

branch_matches_arg() {
  local branch="$1" arg="$2"
  if [ -z "$branch" ]; then
    return 1
  fi
  [ "$branch" = "$arg" ] || [ "$branch" = "session/$arg" ]
}

is_session_branch() {
  case "$1" in
    session/*) return 0 ;;
    *) return 1 ;;
  esac
}

iso_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Convert an ISO8601 UTC timestamp to epoch seconds. BSD date (macOS) needs an
# explicit input format; GNU date (Linux) parses the string directly.
iso_to_epoch() {
  local iso="$1"
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null \
    || date -u -d "$iso" +%s 2>/dev/null
}

write_marker() {
  local admin="$1" branch="$2" started_at="$3" refreshed_at="$4"
  cat >"$admin/$MARKER_FILE" <<EOF
{
  "branch": "$branch",
  "startedAt": "$started_at",
  "refreshedAt": "$refreshed_at",
  "host": "$(hostname)",
  "pid": $$,
  "ttlSeconds": $ACTIVE_EDIT_TTL_SECONDS
}
EOF
}

# Rewrite only the marker's refreshedAt field, preserving every other field. A
# temp file plus mv avoids the BSD/GNU divergence of `sed -i`.
refresh_marker() {
  local marker="$1" now tmp
  now="$(iso_now)"
  tmp="$(mktemp)"
  sed 's/\("refreshedAt"[[:space:]]*:[[:space:]]*"\)[^"]*\(".*\)/\1'"$now"'\2/' "$marker" >"$tmp"
  mv "$tmp" "$marker"
}

# Parse `git worktree list --porcelain` into parallel arrays WT_PATHS / WT_BRANCHES
# (short branch name, empty for a detached entry).
list_worktrees() {
  WT_PATHS=()
  WT_BRANCHES=()
  local path="" branch="" line
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "branch "*)
        branch="${line#branch }"
        branch="${branch#refs/heads/}"
        ;;
      "detached") branch="" ;;
      "")
        if [ -n "$path" ]; then
          WT_PATHS+=("$path")
          WT_BRANCHES+=("$branch")
        fi
        path=""
        branch=""
        ;;
    esac
  done < <(git -C "$root" worktree list --porcelain)
  if [ -n "$path" ]; then
    WT_PATHS+=("$path")
    WT_BRANCHES+=("$branch")
  fi
}

# Resolve a <slug|path|branch> argument to a single worktree. Sets RESOLVED_PATH
# and RESOLVED_BRANCH. With mutating=1, reject a detached entry or a branch
# outside session/*.
resolve_worktree() {
  local arg="$1" mutating="$2"
  list_worktrees
  local arg_abs=""
  if [ -d "$arg" ]; then
    arg_abs="$(cd "$arg" && pwd)"
  fi
  local i match_idx=-1 matches=0
  for i in "${!WT_PATHS[@]}"; do
    local p="${WT_PATHS[$i]}" b="${WT_BRANCHES[$i]}"
    if [ -n "$arg_abs" ] && [ "$p" = "$arg_abs" ]; then
      match_idx=$i
      matches=$((matches + 1))
      continue
    fi
    if branch_matches_arg "$b" "$arg"; then
      match_idx=$i
      matches=$((matches + 1))
    fi
  done
  if [ "$matches" -eq 0 ]; then
    echo "worktree: no worktree matches '$arg'" >&2
    exit 1
  fi
  if [ "$matches" -gt 1 ]; then
    echo "worktree: '$arg' matches more than one worktree; pass an exact path or branch" >&2
    exit 1
  fi
  RESOLVED_PATH="${WT_PATHS[$match_idx]}"
  RESOLVED_BRANCH="${WT_BRANCHES[$match_idx]}"
  if [ "$mutating" = "1" ]; then
    if [ -z "$RESOLVED_BRANCH" ]; then
      echo "worktree: '$arg' is a detached worktree; refusing" >&2
      exit 1
    fi
    if ! is_session_branch "$RESOLVED_BRANCH"; then
      echo "worktree: branch '$RESOLVED_BRANCH' is outside session/*; refusing" >&2
      exit 1
    fi
  fi
}

# Conservative active-edit status (NFR-4): a fresh marker reads active; otherwise
# a dirty tree or anything unknown reads "possibly active", never idle.
edit_status() {
  local admin="$1" path="$2" now_epoch="$3"
  local marker="$admin/$MARKER_FILE"
  if [ -n "$admin" ] && [ -f "$marker" ]; then
    local refreshed_at refreshed_epoch
    refreshed_at="$(sed -n 's/.*"refreshedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$marker")"
    refreshed_epoch="$(iso_to_epoch "$refreshed_at" || true)"
    if [ -n "$refreshed_epoch" ]; then
      local age=$((now_epoch - refreshed_epoch))
      if [ "$age" -ge 0 ] && [ "$age" -le "$ACTIVE_EDIT_TTL_SECONDS" ]; then
        echo "active (marker refreshed ${age}s ago)"
        return
      fi
    fi
  fi
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    echo "possibly active (dirty working tree)"
    return
  fi
  echo "possibly active (active editing cannot be confirmed or ruled out)"
}

usage_create() {
  echo "usage: scripts/worktree.sh create <slug> (--desc <text> | --desc-file <path>) [--from <ref>]" >&2
}

read_create_description() {
  local desc="$1" desc_file="$2"
  if [ -n "$desc_file" ]; then
    if [ ! -f "$desc_file" ]; then
      echo "worktree create: --desc-file not found: $desc_file" >&2
      exit 1
    fi
    cat "$desc_file"
    return
  fi
  printf '%s' "$desc"
}

cmd_create() {
  if [ "$#" -lt 1 ]; then
    usage_create
    exit 2
  fi
  local slug="$1"
  shift
  local desc="" desc_file="" from="$DEFAULT_REF" have_desc=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --desc)
        desc="${2:-}"
        have_desc=1
        shift 2
        ;;
      --desc-file)
        desc_file="${2:-}"
        have_desc=1
        shift 2
        ;;
      --from)
        from="${2:-}"
        shift 2
        ;;
      *)
        echo "worktree create: unknown argument '$1'" >&2
        usage_create
        exit 2
        ;;
    esac
  done
  if [ "$have_desc" -ne 1 ]; then
    echo "worktree create: a description is required (--desc <text> or --desc-file <path>)" >&2
    usage_create
    exit 2
  fi
  if ! printf '%s' "$slug" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
    echo "worktree create: invalid slug '$slug' (expected ^[a-z0-9][a-z0-9-]*\$)" >&2
    exit 2
  fi
  local branch dir base_dir desc_content admin marker now
  branch="$(session_branch_for_slug "$slug")"
  base_dir="$(worktree_storage_root)"
  dir="$base_dir/$slug"
  mkdir -p "$base_dir"
  if [ -e "$dir" ]; then
    echo "worktree create: target path already exists: $dir" >&2
    exit 1
  fi
  desc_content="$(read_create_description "$desc" "$desc_file")"
  git -C "$root" worktree add -b "$branch" "$dir" "$from"
  # A linked worktree's .git is a file, so its own `prepare` skips the
  # `[ -d .git ]` guard; set the relative hook path explicitly here.
  git -C "$dir" config core.hooksPath .githooks
  admin="$(git -C "$dir" rev-parse --absolute-git-dir)"
  marker="$admin/$MARKER_FILE"
  printf '%s\n' "$desc_content" >"$admin/$RECORD_FILE"
  now="$(iso_now)"
  write_marker "$admin" "$branch" "$now" "$now"
  (cd "$dir" && pnpm install --frozen-lockfile)
  refresh_marker "$marker"
  echo ""
  echo "[worktree] created session worktree"
  echo "  branch: $branch"
  echo "  path:   $dir"
  echo "  base:   $from"
  echo "  task:   $admin/$RECORD_FILE"
  echo "  marker: $admin/$MARKER_FILE"
  echo ""
  echo "Enter it with the harness 'EnterWorktree $dir' tool, or 'cd $dir'."
  echo "Per-worktree DoD: run 'pnpm run check' inside the worktree before committing."
}

cmd_list() {
  list_worktrees
  local now_epoch
  now_epoch="$(date -u +%s)"
  local i
  for i in "${!WT_PATHS[@]}"; do
    local p="${WT_PATHS[$i]}" b="${WT_BRANCHES[$i]}"
    local admin task status
    admin="$(git -C "$p" rev-parse --absolute-git-dir 2>/dev/null || true)"
    if [ -n "$admin" ] && [ -f "$admin/$RECORD_FILE" ]; then
      task="$(head -1 "$admin/$RECORD_FILE")"
    else
      task="(no task description recorded)"
    fi
    status="$(edit_status "$admin" "$p" "$now_epoch")"
    printf '%s\n' "${b:-(detached)}"
    printf '  path:   %s\n' "$p"
    printf '  task:   %s\n' "$task"
    printf '  status: %s\n' "$status"
    echo ""
  done
}

cmd_touch() {
  if [ "$#" -lt 1 ]; then
    echo "usage: scripts/worktree.sh touch <slug|path|branch>" >&2
    exit 2
  fi
  resolve_worktree "$1" 1
  local admin
  admin="$(git -C "$RESOLVED_PATH" rev-parse --absolute-git-dir)"
  local marker="$admin/$MARKER_FILE"
  if [ ! -f "$marker" ]; then
    echo "worktree touch: no active-edit marker at $marker (created by 'worktree create')" >&2
    exit 1
  fi
  refresh_marker "$marker"
  echo "[worktree] refreshed active-edit marker: $marker"
}

assert_release_invoked_outside_target() {
  local dir="$1"
  local here
  here="$(pwd -P)"
  if [ "$here" = "$dir" ] || [ "$root" = "$dir" ]; then
    echo "worktree release: run this from the primary checkout, not from inside $dir" >&2
    exit 1
  fi
}

cmd_release() {
  if [ "$#" -lt 1 ]; then
    echo "usage: scripts/worktree.sh release <slug|path|branch> [--into <ref>]" >&2
    exit 2
  fi
  local target="$1"
  shift
  local into="$DEFAULT_REF"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --into)
        into="${2:-}"
        shift 2
        ;;
      *)
        echo "worktree release: unknown argument '$1'" >&2
        exit 2
        ;;
    esac
  done
  resolve_worktree "$target" 1
  local dir="$RESOLVED_PATH" branch="$RESOLVED_BRANCH"
  assert_release_invoked_outside_target "$dir"
  if ! git -C "$root" rev-parse --verify --quiet "$into" >/dev/null; then
    echo "worktree release: integration base '$into' does not resolve" >&2
    exit 1
  fi
  # Merge-safety preflight before removing anything: refuse an unmerged branch.
  if ! git -C "$root" merge-base --is-ancestor "refs/heads/$branch" "$into"; then
    echo "worktree release: branch '$branch' is not merged into '$into'; nothing removed." >&2
    echo "  Integrate it via /ship plus the explicit merge/PR step, or reset a disposable proof commit off first." >&2
    exit 1
  fi
  # Align git branch -d's own merged-check to the validated base so the two agree.
  if ! git -C "$root" branch --set-upstream-to="$into" "$branch" >/dev/null; then
    echo "worktree release: could not set upstream of '$branch' to '$into'; nothing removed." >&2
    exit 1
  fi
  # Remove the worktree first to free the branch, then delete via the safe -d.
  git -C "$root" worktree remove "$dir"
  git -C "$root" branch -d "$branch"
  echo "[worktree] released: removed worktree $dir and branch $branch (integrated into $into)"
}

main() {
  if [ "$#" -lt 1 ]; then
    echo "usage: scripts/worktree.sh <create|list|touch|release> ..." >&2
    exit 2
  fi
  local sub="$1"
  shift
  case "$sub" in
    create) cmd_create "$@" ;;
    list) cmd_list "$@" ;;
    touch) cmd_touch "$@" ;;
    release) cmd_release "$@" ;;
    *)
      echo "worktree: unknown subcommand '$sub'" >&2
      echo "usage: scripts/worktree.sh <create|list|touch|release> ..." >&2
      exit 2
      ;;
  esac
}

main "$@"
