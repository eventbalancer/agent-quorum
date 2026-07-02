# Web workspace

Bare `agent-quorum` in a dual-TTY terminal (both stdin and stdout are TTYs)
starts the local web workspace: an in-process, loopback-only HTTP server that
serves a self-contained chat page. This page documents the runtime contract of
that surface — what is served, how to stop it, and what it never does.

## Opening

```sh
agent-quorum
```

The command prints a `workspace:` block; the first line is stable for scripts
and carries the URL to open:

```text
workspace: http://127.0.0.1:4747/
  note:  preferred port 4747 busy — using an ephemeral port      (only on fallback)
  open:  automatic browser open unavailable — open the url above (only on open failure)
  chat:  local first slice — messages stay in this process and are discarded on exit
  stop:  Ctrl-C stops the local server
```

After printing the URL, a best-effort platform opener (`open` on macOS,
`xdg-open` on Linux, `start` on Windows) tries to open the browser. A spawn
failure or a nonzero opener exit falls back to the printed URL and adds the
`open:` hint; the workspace keeps serving either way.

## Served page and HTTP contract

- `GET /` — `200 text/html; charset=utf-8`, `cache-control: no-store`. The chat
  page: a transcript region, a message input, and a send button, with an inline
  script that loads the transcript on start and posts on submit. The HTML
  references no external URL (no CDN fonts or scripts).
- `GET /api/messages` — `200 application/json`:
  `{"messages": [{"id": 1, "text": "…", "ts": "<ISO>"}, …]}` in insertion
  order.
- `POST /api/messages` with a JSON body `{"text": "…"}` — trims `text`; a
  non-empty result answers `201` with `{"message": {…}}`; invalid JSON or a
  missing/empty text answers `400 {"error": "…"}`; a body over 256 KiB answers
  `413`.
- Any other path or method — `404 {"error": "not found"}`.

## Privacy

The first slice is structurally local:

- The server binds `127.0.0.1` only — never a non-local interface.
- The transcript is an in-memory, per-process array; it is discarded when the
  process exits. Nothing is persisted.
- The no-argument path performs no provider preflight and no outbound call; the
  web module imports no provider, stage, or config-store code, and the served
  page references no external resource.

## Port behavior

The server prefers port `4747`. When the preferred port is busy, it falls back
to an ephemeral port and prints the `note:` line; the `workspace:` line always
carries the actually bound port. When neither bind succeeds, the command exits
`1` with a `web workspace: cannot bind http://127.0.0.1: <code>` message. There
is no configuration surface for the port in this slice.

## Stopping

Ctrl-C (SIGINT) or SIGTERM closes the server — established and idle keep-alive
connections included — frees the port, and exits `0`. The server runs
in-process, so no orphan process can outlive the command; the only spawned
child is the short-lived, detached browser opener.

## Non-TTY behavior

The workspace opens only in a dual-TTY terminal. With no arguments in any
non-interactive context — piped or redirected stdio — `agent-quorum` prints the
global help and exits `0`, unchanged.

## Preserved surfaces

Every explicit CLI command (`plan`, `launch`, `status`, `show`, `logs`,
`prune`, `intervene`, `setup`, `config`, `--help`, `--version`) and the public
Node API are untouched by the workspace; see [`cli.md`](cli.md) and
[`api.md`](api.md).
