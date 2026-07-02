#!/usr/bin/env bash
# Session worktree lifecycle for agent-quorum. Each subcommand keeps a session's
# work in its own linked git worktree on a session/<slug> branch so the unmodified
# pre-commit hook (pnpm run check + git add -u) operates only on that tree.
#
#   create <slug> (--desc <text> | --desc-file <path>) [--from <ref>]
#   list
#   open <slug|path|branch> [--editor <bin>]
#   switch [root|<slug|path|branch>]
#   touch <slug|path|branch>
#   done <slug|path|branch>
#   reopen <slug|path|branch>
#   release <slug|path|branch> [--into <ref>]
#
# Durable carriers live in each worktree's git admin dir (outside any working
# tree, pruned when the worktree is removed): a task description (agent-quorum-task.md),
# a TTL-stamped active-edit marker (agent-quorum-active-edit.json), and, once the
# session is marked done, a done marker (agent-quorum-done.json).
set -euo pipefail

readonly ACTIVE_EDIT_TTL_SECONDS=900
readonly DEFAULT_REF="main"
readonly DEFAULT_EDITOR_LAUNCHERS="cursor code"
readonly RECORD_FILE="agent-quorum-task.md"
readonly MARKER_FILE="agent-quorum-active-edit.json"
readonly DONE_FILE="agent-quorum-done.json"

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

json_string_field() {
  local file="$1" field="$2"
  sed -n 's/.*"'"$field"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file"
}

branch_integration_note() {
  local branch="$1"
  local note="integration into $DEFAULT_REF unknown ('$DEFAULT_REF' did not resolve)"
  if git -C "$root" rev-parse --verify --quiet "$DEFAULT_REF" >/dev/null; then
    if git -C "$root" merge-base --is-ancestor "refs/heads/$branch" "$DEFAULT_REF"; then
      note="integrated into $DEFAULT_REF; 'worktree release $branch' can remove it"
    else
      note="not yet integrated into $DEFAULT_REF; integrate via /ship before releasing"
    fi
  fi
  printf '%s' "$note"
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

# Stamp the terminal done marker. Its presence makes edit_status read "done" and
# the selection gate skip the worktree by default; `reopen` removes it.
write_done_marker() {
  local admin="$1" branch="$2" done_at="$3"
  cat >"$admin/$DONE_FILE" <<EOF
{
  "branch": "$branch",
  "doneAt": "$done_at",
  "host": "$(hostname)"
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
  local done_marker="$admin/$DONE_FILE"
  if [ -n "$admin" ] && [ -f "$done_marker" ]; then
    local done_at
    done_at="$(json_string_field "$done_marker" "doneAt")"
    if [ -n "$done_at" ]; then
      echo "done (marked $done_at)"
    else
      echo "done"
    fi
    return
  fi
  local marker="$admin/$MARKER_FILE"
  if [ -n "$admin" ] && [ -f "$marker" ]; then
    local refreshed_at refreshed_epoch
    refreshed_at="$(json_string_field "$marker" "refreshedAt")"
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

# Fast-forward the default local base to its upstream before branching, so a
# session never starts from a stale main while the loop runs under any provider
# CLI. Best-effort and fast-forward-only: a missing origin, no upstream, offline
# fetch, divergence, or a dirty base leaves the local ref untouched and the
# worktree is still created. Skipped when the operator passes an explicit --from.
sync_default_base() {
  local base="$1" upstream current before after
  git -C "$root" rev-parse --verify --quiet "refs/heads/$base" >/dev/null 2>&1 || return 0
  upstream="$(git -C "$root" rev-parse --abbrev-ref --symbolic-full-name "$base@{upstream}" 2>/dev/null)" || return 0
  [ -n "$upstream" ] || return 0
  git -C "$root" fetch --quiet "${upstream%%/*}" "${upstream#*/}" 2>/dev/null || return 0
  before="$(git -C "$root" rev-parse --quiet --verify "refs/heads/$base" 2>/dev/null || true)"
  current="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ "$current" = "$base" ]; then
    git -C "$root" merge --ff-only "$upstream" >/dev/null 2>&1 || return 0
  else
    # `.` is the local repo: fast-forward the non-checked-out base to the freshly
    # fetched upstream (fetch refuses a non-fast-forward branch update).
    git -C "$root" fetch --quiet . "$upstream:$base" >/dev/null 2>&1 || return 0
  fi
  after="$(git -C "$root" rev-parse --quiet --verify "refs/heads/$base" 2>/dev/null || true)"
  if [ -n "$after" ] && [ "$before" != "$after" ]; then
    echo "[worktree] fast-forwarded $base to $upstream before branching"
  fi
}

cmd_create() {
  if [ "$#" -lt 1 ]; then
    usage_create
    exit 2
  fi
  local slug="$1"
  shift
  local desc="" desc_file="" from="$DEFAULT_REF" have_desc=0 from_overridden=0
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
        from_overridden=1
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
  if [ "$from_overridden" -eq 0 ]; then
    sync_default_base "$from" || true
  fi
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
  echo "Open it in the operator's editor with 'pnpm run worktree:open $slug'."
  echo "Per-worktree DoD: run 'pnpm run check' and 'pnpm run test' inside the worktree before committing."
}

worktree_task_description() {
  local admin="$1"
  if [ -n "$admin" ] && [ -f "$admin/$RECORD_FILE" ]; then
    head -1 "$admin/$RECORD_FILE"
    return
  fi
  echo "(no task description recorded)"
}

print_worktree_task_and_status() {
  local path="$1" now_epoch="$2"
  local admin status
  admin="$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null || true)"
  status="$(edit_status "$admin" "$path" "$now_epoch")"
  printf '  task:   %s\n' "$(worktree_task_description "$admin")"
  printf '  status: %s\n' "$status"
}

cmd_list() {
  list_worktrees
  local now_epoch
  now_epoch="$(date -u +%s)"
  local i
  for i in "${!WT_PATHS[@]}"; do
    local p="${WT_PATHS[$i]}" b="${WT_BRANCHES[$i]}"
    printf '%s\n' "${b:-(detached)}"
    printf '  path:   %s\n' "$p"
    print_worktree_task_and_status "$p" "$now_epoch"
    echo ""
  done
}

usage_open() {
  echo "usage: scripts/worktree.sh open <slug|path|branch> [--editor <bin>]" >&2
}

resolve_editor_launcher() {
  local requested="$1" candidate tried=""
  if [ -n "$requested" ]; then
    if command -v "$requested" >/dev/null 2>&1; then
      echo "$requested"
      return
    fi
    echo "worktree open: editor launcher not found on PATH: $requested" >&2
    return 1
  fi
  for candidate in $DEFAULT_EDITOR_LAUNCHERS; do
    if [ -n "$tried" ]; then
      tried="$tried, '$candidate'"
    else
      tried="'$candidate'"
    fi
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  echo "worktree open: no editor launcher found (tried $tried); pass --editor <bin>" >&2
  return 1
}

cmd_open() {
  if [ "$#" -lt 1 ]; then
    usage_open
    exit 2
  fi
  local target="$1"
  shift
  local editor=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --editor)
        editor="${2:-}"
        shift 2
        ;;
      *)
        echo "worktree open: unknown argument '$1'" >&2
        usage_open
        exit 2
        ;;
    esac
  done
  resolve_worktree "$target" 0
  local launcher
  launcher="$(resolve_editor_launcher "$editor")"
  "$launcher" "$RESOLVED_PATH"
  echo "[worktree] opened ${RESOLVED_BRANCH:-(detached)} in $launcher"
  echo "  path:   $RESOLVED_PATH"
}

# Label a checkout path against the parsed worktree arrays. `git worktree list`
# always reports the primary checkout first, so WT_PATHS[0] is root.
describe_context() {
  local path="$1" i
  if [ -z "$path" ]; then
    echo "(not inside a git repository)"
    return
  fi
  if [ "$path" = "${WT_PATHS[0]}" ]; then
    echo "root (primary checkout, branch ${WT_BRANCHES[0]:-detached})"
    return
  fi
  for i in "${!WT_PATHS[@]}"; do
    if [ "${WT_PATHS[$i]}" = "$path" ]; then
      echo "linked worktree (branch ${WT_BRANCHES[$i]:-detached})"
      return
    fi
  done
  echo "(checkout not registered in this repository)"
}

switch_target_kind() {
  local dest="$1" primary="$2" branch="$3"
  if [ "$dest" = "$primary" ]; then
    echo "root (primary checkout)"
    return
  fi
  if is_session_branch "${branch:-}"; then
    echo "session worktree"
    return
  fi
  echo "linked worktree"
}

# Resolve a switch target and print the handoff block for the agent. The script
# cannot change the caller's working directory; the agent performs the move with
# the host EnterWorktree/ExitWorktree tools or cd, then verifies the handoff.
cmd_switch() {
  list_worktrees
  local primary="${WT_PATHS[0]}" primary_branch="${WT_BRANCHES[0]}"
  local current
  current="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$#" -lt 1 ]; then
    echo "[worktree] current context"
    printf '  path:   %s\n' "${current:-(none)}"
    printf '  kind:   %s\n' "$(describe_context "$current")"
    echo ""
    echo "Switch with 'scripts/worktree.sh switch <root|slug|path|branch>'."
    echo "Targets: 'root' (primary checkout) plus the entries from 'scripts/worktree.sh list'."
    return
  fi
  if [ "$#" -gt 1 ]; then
    echo "worktree switch: unexpected argument '$2'" >&2
    echo "usage: scripts/worktree.sh switch [root|<slug|path|branch>]" >&2
    exit 2
  fi
  local target="$1"
  if [ "$target" = "root" ]; then
    RESOLVED_PATH="$primary"
    RESOLVED_BRANCH="$primary_branch"
  else
    resolve_worktree "$target" 0
  fi
  local dest="$RESOLVED_PATH" branch="$RESOLVED_BRANCH"
  local kind
  kind="$(switch_target_kind "$dest" "$primary" "$branch")"
  echo "[worktree] switch context"
  printf '  from:   %s\n' "${current:-(unknown)}"
  printf '  to:     %s\n' "$dest"
  printf '  branch: %s\n' "${branch:-(detached)}"
  printf '  kind:   %s\n' "$kind"
  if [ "$dest" != "$primary" ]; then
    local admin now_epoch
    now_epoch="$(date -u +%s)"
    admin="$(git -C "$dest" rev-parse --absolute-git-dir 2>/dev/null || true)"
    print_worktree_task_and_status "$dest" "$now_epoch"
    if [ -n "$admin" ] && [ -f "$admin/$DONE_FILE" ]; then
      echo "  note:   marked done; run 'scripts/worktree.sh reopen ${branch:-$dest}' before editing"
    elif [ -n "$admin" ] && [ -f "$admin/$MARKER_FILE" ]; then
      refresh_marker "$admin/$MARKER_FILE"
      echo "  marker: refreshed $admin/$MARKER_FILE"
    fi
  fi
  echo ""
  if [ "$dest" = "$current" ]; then
    echo "Already in this context; no handoff needed."
    return
  fi
  if [ "$dest" = "$primary" ]; then
    echo "Enter it with the harness 'ExitWorktree' tool (when the session entered via EnterWorktree), or 'cd $dest'."
  else
    echo "Enter it with the harness 'EnterWorktree $dest' tool, or 'cd $dest'."
  fi
  echo "Confirm the handoff: 'git rev-parse --show-toplevel' must print $dest."
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

cmd_done() {
  if [ "$#" -lt 1 ]; then
    echo "usage: scripts/worktree.sh done <slug|path|branch>" >&2
    exit 2
  fi
  resolve_worktree "$1" 1
  local dir="$RESOLVED_PATH" branch="$RESOLVED_BRANCH" admin now
  admin="$(git -C "$dir" rev-parse --absolute-git-dir)"
  now="$(iso_now)"
  write_done_marker "$admin" "$branch" "$now"
  echo "[worktree] marked done: $branch"
  echo "  path:   $dir"
  echo "  done:   $admin/$DONE_FILE"
  echo "  branch: $(branch_integration_note "$branch")"
  echo "The selection gate now skips this worktree by default; reopen with 'worktree:reopen $branch'."
}

cmd_reopen() {
  if [ "$#" -lt 1 ]; then
    echo "usage: scripts/worktree.sh reopen <slug|path|branch>" >&2
    exit 2
  fi
  resolve_worktree "$1" 1
  local dir="$RESOLVED_PATH" branch="$RESOLVED_BRANCH" admin
  admin="$(git -C "$dir" rev-parse --absolute-git-dir)"
  local done_marker="$admin/$DONE_FILE"
  if [ ! -f "$done_marker" ]; then
    echo "worktree reopen: '$branch' is not marked done (no $done_marker)" >&2
    exit 1
  fi
  rm -f "$done_marker"
  local marker="$admin/$MARKER_FILE"
  if [ -f "$marker" ]; then
    refresh_marker "$marker"
  fi
  echo "[worktree] reopened: $branch (cleared done marker; back in the selection gate)"
  echo "  path:   $dir"
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
    echo "usage: scripts/worktree.sh <create|list|open|switch|touch|done|reopen|release> ..." >&2
    exit 2
  fi
  local sub="$1"
  shift
  case "$sub" in
    create) cmd_create "$@" ;;
    list) cmd_list "$@" ;;
    open) cmd_open "$@" ;;
    switch) cmd_switch "$@" ;;
    touch) cmd_touch "$@" ;;
    done) cmd_done "$@" ;;
    reopen) cmd_reopen "$@" ;;
    release) cmd_release "$@" ;;
    *)
      echo "worktree: unknown subcommand '$sub'" >&2
      echo "usage: scripts/worktree.sh <create|list|open|switch|touch|done|reopen|release> ..." >&2
      exit 2
      ;;
  esac
}

main "$@"
