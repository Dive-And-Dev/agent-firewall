# Agent Firewall v0.1 — Design Document

**Date:** 2026-02-17
**Status:** Approved
**Stack:** Node.js + TypeScript + Express

---

## 1. Problem Statement

AI agents (Claude Code, OpenClaw, etc.) need host-level access to workspaces, git, and build tools. Giving them direct shell access is an unacceptable security risk. Agent Firewall provides a declarative HTTP API that mediates all host interaction — agents submit tasks, never commands.

## 2. Security Invariants (never violated)

1. **No shell** — API never exposes `run_shell` / `exec(command)`. The only subprocess is the Claude CLI worker, spawned by the server with controlled arguments.
2. **No host asset leakage** — Agent containers never mount host repos, home, or secrets. Host assets are only exposed as "controlled projections" (state, artifacts, redacted excerpts).
3. **Full audit trail** — Every session is persisted to disk: task definition, all turn logs, artifacts, and final state.
4. **No host network** — Agent containers run on isolated bridge networks. `network_mode: host` is forbidden.

## 3. Architecture Decision

**Approach A: Monolithic Express** — chosen for v0.1.

- `MAX_CONCURRENT=1`: no need for queues or cross-thread coordination
- Worker is a spawned child process: Node event loop is not blocked
- Single process: one `npm start`, one log stream, minimal debug overhead
- Pluggable `Worker` interface + `ConcurrencyGate` abstraction allow migration to worker_threads (B) or separate process + queue (C) without changing the API layer

### When to upgrade

- **B (worker_threads):** CPU-bound parsing/diff/embeddings saturates the event loop
- **C (separate process + queue):** `MAX_CONCURRENT > 1`, multi-tenant, or worker crash isolation needed

## 4. API Surface

### Endpoints

| Method | Path | Purpose | Status |
|--------|------|---------|--------|
| `POST` | `/v1/tasks` | Submit a new task | `202` |
| `GET` | `/v1/sessions` | List all sessions | `200` |
| `GET` | `/v1/sessions/:id/state` | Full session state (redacted) | `200` |
| `GET` | `/v1/sessions/:id/artifacts` | Artifact index | `200` |
| `GET` | `/v1/sessions/:id/artifacts/:name` | Download artifact | `200` |
| `GET` | `/v1/sessions/:id/logtail` | Tail session logs (redacted) | `200` |
| `GET` | `/v1/sessions/:id/excerpt` | Read file excerpt (redacted) | `200` |
| `POST` | `/v1/sessions/:id/abort` | Abort a running session | `200` |

### POST /v1/tasks — request body

```json
{
  "goal": "Fix the failing test in auth.test.ts",
  "workspace_root": "/Users/chris/Projects/myapp",
  "allowed_tools": ["Bash(npm test *)", "Read", "Edit", "Write"],
  "turns_max": 20,
  "timeout_seconds": 600
}
```

- `goal` — required, string, max 4KB
- `workspace_root` — required, must pass pathGuard (under `AF_ALLOWED_ROOTS`)
- `allowed_tools` — optional, best-effort pass to Claude CLI (fallback: omit flag, record in state)
- `turns_max` — optional, default 20, cap 50
- `timeout_seconds` — optional, default 600, cap 1800

### Error responses

| Condition | Status | Body |
|-----------|--------|------|
| Missing/invalid token | `401` | `{ error: "unauthorized" }` |
| `workspace_root` outside allowed roots | `403` | `{ error: "workspace_root not in allowed roots" }` |
| Another session running | `409` | `{ error: "session already active", active_session_id }` |
| Validation failure | `400` | `{ error: "...", details: [...] }` |

### GET /v1/sessions/:id/logtail — query params

- `stream`: `stdout` | `stderr` | `combined` (default: `combined`)
- `n`: lines (default 50, max 200)
- `grep`: literal filter (not regex in v0.1)
- Hard limit: 32KB response. Truncation appends `\n...<TRUNCATED>`.

### GET /v1/sessions/:id/excerpt — query params

- `path`: required, must pass pathGuard (scoped to session's `workspace_root` from task.json + deny globs)
- `start`: start line (default 1)
- `end`: end line (default start + 200)
- `max_chars`: hard cap (default 16KB, max 64KB)
- Truncation appends `\n...<TRUNCATED>`.

### POST /v1/sessions/:id/abort

Sends SIGTERM to the worker process group. If still alive after 5s, SIGKILL. Updates `shared_state.json` with `status: "failed"` and `error_summary: "Aborted by client"`. Returns `200` with updated state. Returns `404` if session not found, `409` if session is not running.

### Artifact download safety

`GET /v1/sessions/:id/artifacts/:name`: name is looked up in `artifacts.json` index — never used as a filesystem path. If not in index -> 404. No path joining with user input.

## 5. Session Lifecycle

### State machine

```
POST /v1/tasks
     |
     v
  RUNNING --+--> DONE
            +--> FAILED   (error, timeout, or client abort)
            +--> ABORTED  (server restart)
```

### POST /v1/tasks flow

1. Validate request (auth, schema, pathGuard on workspace_root)
2. Acquire concurrency gate (or 409)
3. Generate session_id (UUIDv4)
4. Create `data/sessions/<session_id>/` directory
5. Write `task.json` immediately (crash safety)
6. Write initial `shared_state.json` (status: running)
7. Respond 202 with `{ session_id }`
8. Fire-and-forget: `worker.run(ctx)` in background

### Worker execution (ClaudeCodeWorker)

1. Build prompt from template + goal
2. Spawn: `claude --print --output-format json --max-turns N [--allowedTools ...] -p "<prompt>"`
3. Pipe stdout/stderr to turn log files
4. Parse output (JSON first, regex fallback)
5. On exit:
   - Extract blockers (file:line patterns, max 10, deduplicated)
   - Run git diff / git status -> patch.diff + files_changed (check for `.git` first; skip if not a git repo)
   - Build artifacts (patch.diff, summary.md, test_report.md)
   - Write artifacts.json index (name, path, bytes, sha256)
   - Update shared_state.json
   - Release concurrency gate

### Timeout and process cleanup

- `setTimeout` at `timeout_seconds` after spawn
- On timeout: SIGTERM to process group (`-pid`)
- Still alive after 5s: SIGKILL to process group
- Mark session `failed` with `error_summary: "Timeout after Ns"`

### stdout/stderr buffer management

- Stream to disk (no unbounded memory accumulation)
- Per-turn: `turns/0001/stdout.log`, `turns/0001/stderr.log`
- Single turn log > 50MB -> stop writing, append `<TRUNCATED>`

### Server startup recovery

On boot, scan `data/sessions/*/shared_state.json`:
- `status: "running"` -> set `status: "aborted"`, `error_summary: "Server restarted; task aborted"`
- No PID cleanup (avoid false positives)

## 6. Data Model

### Disk layout

```
data/sessions/<session_id>/
  task.json
  shared_state.json
  artifacts.json
  turns/
    0001/
      stdout.log
      stderr.log
      request.json
      cli_output.json
  out/
    patch.diff
    summary.md
    test_report.md
```

### shared_state.json

```json
{
  "session_id": "abc-123",
  "goal": "Fix the failing test in auth.test.ts",
  "status": "done",
  "turns_completed": 1,
  "turns_max": 20,
  "progress": ["Identified failing test", "Fixed missing mock"],
  "blockers": [
    { "description": "Type error remains", "file": "src/auth/auth.types.ts", "line_range": "12-18" }
  ],
  "files_changed": ["src/auth/auth.test.ts"],
  "artifacts": ["patch.diff", "summary.md"],
  "fallback_events": [],
  "updated_at": "2026-02-17T10:05:30Z",
  "error_summary": null
}
```

### task.json

Includes `template_hash` (sha256 of prompt template used) for audit trail.

### artifacts.json

```json
[
  { "name": "patch.diff", "path": "out/patch.diff", "bytes": 2048, "sha256": "e3b0c44..." }
]
```

## 7. Security Modules

### policy.ts

Loads all `AF_*` env vars into typed config. Single source of truth for allowed roots, deny globs, limits. Validates at startup — missing `AF_BRIDGE_TOKEN` prevents boot.

### pathGuard.ts

Validates any path: resolves symlinks via `realpath`, checks against a provided context root, checks deny globs. Has no upward module dependencies (leaf node), but performs minimal I/O for symlink resolution.

**Context root parameter:** pathGuard accepts a `contextRoot` argument. For task submission, this is the full `AF_ALLOWED_ROOTS` set. For session-scoped APIs (excerpt, logtail), this is the session's `workspace_root` from `task.json` — preventing one task from reading files in a different allowed root.

### redaction.ts

Three-pass pipeline applied to all outgoing text:

1. **Block-level:** PEM private keys, OpenSSH keys, certificates -> `<REDACTED_PRIVATE_KEY_BLOCK>`
2. **Token-level:** `sk-*`, `ghp_*`, `github_pat_*`, `xox[baprs]-*`, JWT, `AKIA*`, Bearer tokens -> prefix preserved (e.g., `sk-***REDACTED***`)
3. **KV-level:** `PASSWORD=*`, `"private_key": "*"`, `secret=*` -> value replaced with `<REDACTED>`

Design rules:
- Preserve prefixes for debuggability
- Normal git SHAs, UUIDs not redacted (avoid false positives)
- No entropy detection or DLP in v0.1

### promptTemplate.ts

Hardcoded base template with `{{goal}}`, `{{workspace}}`, `{{constraints}}` placeholders. Optional `AF_PROMPT_APPEND` (max 2KB, basic injection guard rejects strings containing `ignore previous`, `read /`, etc.). Records `template_hash` in task.json.

## 8. Module Map

```
src/
  index.ts
  config.ts
  routes.ts
  middleware/
    auth.ts
  sessions/
    sessionStore.ts
    stateBuilder.ts
  security/
    policy.ts
    pathGuard.ts
    redaction.ts
    promptTemplate.ts
  workers/
    types.ts
    claudeCode.ts
    concurrencyGate.ts
  utils/
    exec.ts
    blockerExtractor.ts
    filesChanged.ts
    artifacts.ts
```

### Dependency rules

- Security modules are leaf nodes — no upward dependencies (pathGuard performs minimal I/O for realpath but has no module dependencies)
- Worker depends on utils + security only — never imports Express/routes
- SessionStore is the only module that touches disk
- Config loaded once at startup, passed by reference

## 9. Key Interfaces

### Worker

```typescript
interface Worker {
  name: string;
  run(ctx: RunContext): Promise<RunResult>;
}
```

v0.1: `ClaudeCodeWorker` only. Pluggable for Aider/Codex in future.

### ConcurrencyGate

```typescript
interface ConcurrencyGate {
  acquire(workspaceRoot: string, sessionId: string): boolean;
  release(workspaceRoot: string): void;
  activeSessionId(): string | null;
}
```

v0.1: global mutex (ignores key). v0.2: keyed by workspace root.

### SessionStore

```typescript
interface SessionStore {
  create(sessionId: string, task: TaskInput): Promise<void>;
  getState(sessionId: string): Promise<SharedState | null>;
  updateState(sessionId: string, patch: Partial<SharedState>): Promise<void>;
  getArtifacts(sessionId: string): Promise<ArtifactEntry[]>;
  getArtifactPath(sessionId: string, name: string): Promise<string | null>;
  listSessions(): Promise<SessionSummary[]>;
  writeTurnLog(sessionId: string, turn: number, stream: string, data: Buffer): Promise<void>;
  markAbortedOnStartup(): Promise<void>;
}
```

## 10. Container Isolation

### docker-compose.yml

```yaml
services:
  agent:
    image: openclaw/openclaw:latest
    environment:
      - FIREWALL_URL=http://host.docker.internal:${AF_PORT:-8787}
      - AF_BRIDGE_TOKEN=${AF_BRIDGE_TOKEN}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - openclaw_data:/data
    networks:
      - af_bridge

volumes:
  openclaw_data:

networks:
  af_bridge:
    driver: bridge
```

Firewall runs on host (not in compose). Compose is for agent containers only.

### Linux bind address

| Platform | `AF_BIND` | Additional step |
|----------|-----------|-----------------|
| macOS | `127.0.0.1` | None |
| Linux (no containers) | `127.0.0.1` | None |
| Linux + containers | `0.0.0.0` | Host firewall: only allow docker0 on port 8787 |

## 11. Environment Variables

```bash
AF_PORT=8787
AF_BIND=127.0.0.1
AF_BRIDGE_TOKEN=              # Required
AF_DATA_DIR=./data/sessions
AF_ALLOWED_ROOTS=/path/a,/path/b
AF_DENY_GLOBS=**/.env,**/.ssh/**,**/credentials*,**/*.pem,**/*.key
AF_PROMPT_APPEND=             # Optional, max 2KB
AF_MAX_CONCURRENT=1
```

## 12. Testing Strategy

### Unit tests (pure, no I/O)

- **redaction.ts** — ~15 tests: PEM blocks, token formats, KV pairs, false-positive avoidance
- **pathGuard.ts** — ~8 tests: allowed/denied paths, traversal, symlinks, deny globs
- **policy.ts** — ~5 tests: parsing, defaults, validation, caps
- **promptTemplate.ts** — ~5 tests: substitution, append, length guard, injection guard
- **blockerExtractor.ts** — ~5 tests: file:line extraction, dedup, cap
- **exec.ts** — ~4 tests: spawn, timeout, SIGTERM/SIGKILL, process group

### Integration tests (supertest + temp dirs)

- Auth middleware (3 tests)
- POST /v1/tasks validation + lifecycle (5 tests)
- GET endpoints: state, artifacts, logtail, excerpt (6 tests)
- Startup recovery (2 tests)

### Acceptance criteria

1. `curl POST /v1/tasks` -> 202 + session_id
2. Poll `GET /state` -> status running -> done/failed, blockers contain file + line_range
3. `GET /artifacts` -> index; download patch.diff -> valid diff
4. `POST /v1/tasks` with `workspace_root=~/.ssh` -> 403
5. No Authorization header -> 401
6. `docker compose up` -> container cannot see ~/Projects or ~/.ssh, can reach Firewall API

### Tooling

- **Framework:** vitest
- **HTTP testing:** supertest
- **Coverage:** vitest --coverage, target 80%+

## 13. Threat Model Summary

- Firewall does not provide shell — cannot degrade into SSH
- Agent containers do not mount host assets — no side-channel
- Host assets are only exposed via task API as controlled projections (state + artifacts + redacted reads)
- `network_mode: host` is forbidden — containers cannot scan host listening ports
