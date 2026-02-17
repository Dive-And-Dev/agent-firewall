# Agent Firewall

A declarative HTTP API that mediates all AI agent-to-host interaction. Agents submit tasks, never commands.

## Threat Model

| Invariant | Enforcement |
|-----------|-------------|
| No shell | API never exposes run_shell or exec(command). Only the Claude CLI worker is spawned, with controlled arguments. |
| No host asset leakage | Agent containers never mount /home, secrets, or credentials. All output passes through a three-pass redaction pipeline before leaving the server. |
| Full audit trail | Every session is persisted to disk: task definition, shared state, artifacts. |
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

**Docker:**

```bash
docker compose up --build
```

The server listens on `127.0.0.1:8787` by default.

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

# List artifacts
curl -H "Authorization: Bearer $AF_BRIDGE_TOKEN" \
  http://localhost:8787/v1/sessions/$SESSION_ID/artifacts

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
| GET | /v1/sessions/:id/artifacts | 200/404 | Artifact index |
| GET | /v1/sessions/:id/artifacts/:name | 200/404 | Download artifact |
| GET | /v1/sessions/:id/excerpt | 200/403/404 | Read workspace file (redacted) |
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
| AF_PROMPT_APPEND | no | (empty) | Extra instructions appended to agent prompt |

## Security Notes

### Redaction pipeline

All text returned to callers passes through a three-pass redaction pipeline:
- Block-level: PEM private keys, certificates
- Token-level: API keys (OpenAI/Anthropic/GitHub/Slack), JWTs, AWS access keys
- KV-level: PASSWORD=, SECRET=, JSON private_key values

### PathGuard

Every file path is validated: resolved to absolute, checked against AF_ALLOWED_ROOTS, checked against AF_DENY_GLOBS.

### Artifact download

Artifact names are validated against the session's recorded artifact index. Raw filesystem paths are never constructed from user input.

## Development

```bash
npm install          # install dependencies
npm run dev          # start with hot reload
npm test             # run vitest
npm run build        # compile TypeScript
```

## License

MIT
