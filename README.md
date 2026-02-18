# Agent Firewall

A declarative HTTP API that mediates all AI agent-to-host interaction. Agents submit tasks, never commands.

## Threat Model

| Invariant | Enforcement |
|-----------|-------------|
| No shell | API never exposes run_shell or exec(command). Only the Claude CLI worker is spawned with controlled arguments. |
| No host asset leakage | Agent containers never mount /home, secrets, or credentials. All output passes through a three-pass redaction pipeline before leaving the server. |
| Full audit trail | Every session persists to disk: task definition, shared state, raw stdout/stderr logs, parsed CLI output, patch diff, artifacts. |
| No host network | Agent containers run on isolated bridge networks. |

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
# Required:
# AF_BRIDGE_TOKEN=<random secret>  (used by agents to authenticate)
# AF_ALLOWED_ROOTS=/path/to/workspaces  (comma-separated)
```

### 2. Start the server

**Local (dev):**

```bash
npm install
npm run dev
```

**Docker (single firewall):**

```bash
docker compose up --build
```

**Docker (firewall + agent):**

```bash
# Edit docker-compose.yml: replace openclaw-agent image with your agent image,
# mount your workspace volume, then:
docker compose up --build
```

The server listens on `127.0.0.1:8787` by default (locally) or `0.0.0.0:8787` in Docker.

### 3. Submit a task

```bash
curl -X POST http://localhost:8787/v1/tasks \
  -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Fix the failing test in auth.test.ts",
    "workspace_root": "/workspace/myapp",
    "turns_max": 20,
    "timeout_seconds": 600
  }'
# -> { "session_id": "..." }
```

### 4. Poll for results

```bash
SESSION_ID=<id from above>

# Check state
curl -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  http://localhost:8787/v1/sessions/$SESSION_ID/state

# Stream recent stdout (last 50 lines, redacted)
curl -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  "http://localhost:8787/v1/sessions/$SESSION_ID/logtail?stream=stdout&n=50"

# Filter stderr for errors
curl -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  "http://localhost:8787/v1/sessions/$SESSION_ID/logtail?stream=stderr&grep=Error"

# List artifacts (returns metadata: name, path, bytes, sha256)
curl -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  http://localhost:8787/v1/sessions/$SESSION_ID/artifacts

# Download a specific artifact
curl -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  http://localhost:8787/v1/sessions/$SESSION_ID/artifacts/patch.diff

# Abort if needed
curl -X POST -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  http://localhost:8787/v1/sessions/$SESSION_ID/abort
```

## API Reference

| Method | Path | Status | Description |
|--------|------|--------|-------------|
| POST | /v1/tasks | 202 | Submit task; returns session_id |
| GET | /v1/sessions | 200 | List sessions |
| GET | /v1/sessions/:id/state | 200/404 | Full redacted session state |
| GET | /v1/sessions/:id/artifacts | 200/404 | Artifact index (metadata) |
| GET | /v1/sessions/:id/artifacts/:name | 200/404 | Download artifact file |
| GET | /v1/sessions/:id/excerpt | 200/403/404 | Read workspace file excerpt (redacted) |
| GET | /v1/sessions/:id/logtail | 200/400/404 | Tail session stdout/stderr (redacted) |
| POST | /v1/sessions/:id/abort | 200/404/409 | Abort running session |
| GET | /v1/health | 200 | Server + gate status |

### POST /v1/tasks request body

| Field | Required | Default | Cap |
|-------|----------|---------|-----|
| goal | yes | - | 4 KB |
| workspace_root | yes | - | must be under AF_ALLOWED_ROOTS |
| allowed_tools | no | [] | - |
| turns_max | no | 20 | 50 |
| timeout_seconds | no | 600 | 1800 |

### GET /v1/sessions/:id/logtail query parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| stream | stdout | `stdout` or `stderr` |
| n | 50 | Number of lines to return (capped at `AF_LOGTAIL_MAX_LINES`) |
| grep | (empty) | Filter lines to those containing this string |

Returns: `{ lines: string[], stream: string, n: number }` — all lines are redacted.

### GET /v1/sessions/:id/excerpt query parameters

Supports two naming conventions (backward-compatible):

| Parameter | Alias | Default | Description |
|-----------|-------|---------|-------------|
| line_start | start | 1 | First line (1-indexed) |
| line_end | end | (EOF) | Last line (inclusive) |
| max_chars | - | 0 (unlimited) | Truncate output at N characters |

### GET /v1/sessions/:id/artifacts response

Returns `{ artifacts: ArtifactEntry[] }` where each entry is:

```json
{ "name": "patch.diff", "path": "...", "bytes": 1024, "sha256": "abc..." }
```

## Session Disk Layout

Each session directory (`AF_DATA_DIR/<session_id>/`) contains:

```
task.json              — original request (goal, workspace, flags)
shared_state.json      — live state (status, blockers, artifacts, fallback_events)
turns/
  0001/
    request.json       — CLI flags used (includes is_fallback flag)
    stdout.log         — raw stdout (unredacted audit trail)
    stderr.log         — raw stderr (unredacted audit trail)
    cli_output.json    — parsed JSON output (when --output-format json succeeded)
out/
  patch.diff           — git diff HEAD (or fallback message)
  summary.md           — human-readable task summary
  test_report.md       — extracted test output (if any)
  artifacts.json       — artifact metadata index
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| AF_BRIDGE_TOKEN | yes | - | Shared secret for Bearer auth |
| AF_ALLOWED_ROOTS | yes | - | Comma-separated allowed workspace roots |
| AF_PORT | no | 8787 | Listen port |
| AF_BIND | no | 127.0.0.1 | Bind address (0.0.0.0 in Docker) |
| AF_DENY_GLOBS | no | **/.env,**/.ssh/**,**/credentials*,**/*.pem,**/*.key | Glob patterns always denied |
| AF_DATA_DIR | no | ./data/sessions | Session persistence directory |
| AF_MAX_CONCURRENT | no | 1 | Max concurrent sessions |
| AF_LOGTAIL_MAX_LINES | no | 200 | Maximum lines returnable from logtail |
| AF_PROMPT_APPEND | no | (empty) | Extra instructions appended to agent prompt |

## Docker Compose — Two-Service Setup

The `docker-compose.yml` defines two services:

1. **agent-firewall** — the HTTP API (this repo)
2. **openclaw-agent** — placeholder for your agent container

### How the agent reaches the firewall

The firewall binds to `0.0.0.0:8787` inside Docker and is published on `127.0.0.1:8787` on the host. The agent container uses `host.docker.internal:8787` to reach the firewall via the bridge network.

### Linux bind caveat

On **Linux**, Docker Desktop is not typically used, so `host.docker.internal` doesn't resolve automatically. The compose file includes:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

This maps `host.docker.internal` to the Docker bridge gateway IP, which works if the firewall's `AF_BIND` is `0.0.0.0` (default in compose). **Do not set `AF_BIND=127.0.0.1` on Linux in Docker** — the agent container cannot reach a loopback-bound service on the host.

Alternatives if you can't set `AF_BIND=0.0.0.0`:
- Use `iptables` to forward the port: `iptables -t nat -A PREROUTING -p tcp --dport 8787 -j REDIRECT`
- Use a firewalld/ufw rule to allow the docker0 interface
- Or bind the firewall to the docker0 IP directly: `AF_BIND=172.17.0.1`

## Security Notes

### Redaction pipeline

All text returned to callers passes through a three-pass redaction pipeline:
- Block-level: PEM private keys, certificates
- Token-level: API keys (OpenAI/Anthropic/GitHub/Slack), JWTs, AWS access keys
- KV-level: PASSWORD=, SECRET=, JSON private_key values

Raw logs (`stdout.log`, `stderr.log`) are stored **unredacted** for audit purposes but are never served directly to callers.

### PathGuard

Every file path is validated: resolved to absolute, checked against AF_ALLOWED_ROOTS, checked against AF_DENY_GLOBS. symlinks are followed and verified to remain within allowed bounds.

### Artifact download

Artifact names are validated against the session's recorded artifact allowlist. Raw filesystem paths are never constructed from user-supplied input alone.

### allowedTools fallback

If the Claude CLI doesn't recognize `--allowedTools`, the worker retries without it and records a `fallback_event` in `shared_state.json`. Callers can inspect `state.fallback_events` to detect when tool restrictions were silently dropped.

## Acceptance Test

```bash
AF_BRIDGE_TOKEN=secret \
AF_TEST_WORKSPACE=/tmp/test-workspace \
  bash scripts/acceptance-test.sh
```

## Development

```bash
npm install          # install dependencies
npm run dev          # start with hot reload
npm test             # run vitest
npm run build        # compile TypeScript
```

## License

MIT
