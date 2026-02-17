# Agent Firewall v0.1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a declarative HTTP API that mediates all AI agent-to-host interaction — agents submit tasks, never commands.

**Architecture:** Monolithic Express server (single process, MAX_CONCURRENT=1). Worker spawns Claude CLI as a child process. Security modules (pathGuard, redaction, policy) are pure leaf-node functions. SessionStore handles all disk I/O. All outgoing text passes through a three-pass redaction pipeline.

**Tech Stack:** Node.js 20+, TypeScript 5, Express 4, vitest, supertest

**Design doc:** `docs/plans/2026-02-17-agent-firewall-v0.1-design.md`

---

## Phase 1: Project Scaffolding

### Task 1: Initialize Node.js project with TypeScript

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/index.ts` (placeholder)

**Step 1: Initialize package.json**

```bash
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install express dotenv minimatch uuid
npm install -D typescript @types/node @types/express @types/uuid vitest supertest @types/supertest tsx
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "data"]
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
data/
.env
*.log
.claude/
```

**Step 5: Create .env.example**

```bash
AF_PORT=8787
AF_BIND=127.0.0.1
AF_BRIDGE_TOKEN=
AF_DATA_DIR=./data/sessions
AF_ALLOWED_ROOTS=/Users/chris/Projects,/Users/chris/Work
AF_DENY_GLOBS=**/.env,**/.ssh/**,**/credentials*,**/*.pem,**/*.key
AF_PROMPT_APPEND=
AF_MAX_CONCURRENT=1
```

**Step 6: Create placeholder src/index.ts**

```typescript
console.log('agent-firewall starting...');
```

**Step 7: Add scripts to package.json**

Add to `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Step 8: Verify build**

```bash
npx tsc --noEmit
```

Expected: No errors.

**Step 9: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example src/index.ts
git commit -m "chore: initialize project with TypeScript + Express"
```

---

## Phase 2: Security Modules (leaf nodes, test first)

### Task 2: Config module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.AF_BRIDGE_TOKEN = 'test-token-abc123';
    process.env.AF_ALLOWED_ROOTS = '/tmp/a,/tmp/b';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws if AF_BRIDGE_TOKEN is missing', () => {
    delete process.env.AF_BRIDGE_TOKEN;
    expect(() => loadConfig()).toThrow('AF_BRIDGE_TOKEN');
  });

  it('throws if AF_ALLOWED_ROOTS is missing', () => {
    delete process.env.AF_ALLOWED_ROOTS;
    expect(() => loadConfig()).toThrow('AF_ALLOWED_ROOTS');
  });

  it('parses comma-separated AF_ALLOWED_ROOTS', () => {
    const config = loadConfig();
    expect(config.allowedRoots).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('parses comma-separated AF_DENY_GLOBS', () => {
    process.env.AF_DENY_GLOBS = '**/.env,**/.ssh/**';
    const config = loadConfig();
    expect(config.denyGlobs).toEqual(['**/.env', '**/.ssh/**']);
  });

  it('uses defaults for optional values', () => {
    const config = loadConfig();
    expect(config.port).toBe(8787);
    expect(config.bind).toBe('127.0.0.1');
    expect(config.maxConcurrent).toBe(1);
  });

  it('caps turns_max at 50', () => {
    const config = loadConfig();
    expect(config.turnsMaxCap).toBe(50);
  });

  it('caps timeout_seconds at 1800', () => {
    const config = loadConfig();
    expect(config.timeoutSecondsCap).toBe(1800);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL -- module not found.

**Step 3: Implement config.ts**

```typescript
// src/config.ts
export interface Config {
  port: number;
  bind: string;
  bridgeToken: string;
  dataDir: string;
  allowedRoots: string[];
  denyGlobs: string[];
  promptAppend: string;
  maxConcurrent: number;
  turnsMaxCap: number;
  timeoutSecondsCap: number;
  promptAppendMaxBytes: number;
}

export function loadConfig(): Config {
  const bridgeToken = process.env.AF_BRIDGE_TOKEN;
  if (!bridgeToken) {
    throw new Error('AF_BRIDGE_TOKEN is required but not set');
  }

  const allowedRootsRaw = process.env.AF_ALLOWED_ROOTS;
  if (!allowedRootsRaw) {
    throw new Error('AF_ALLOWED_ROOTS is required but not set');
  }

  const allowedRoots = allowedRootsRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (allowedRoots.length === 0) {
    throw new Error('AF_ALLOWED_ROOTS must contain at least one path');
  }

  const denyGlobsRaw = process.env.AF_DENY_GLOBS || '';
  const denyGlobs = denyGlobsRaw.split(',').map(s => s.trim()).filter(Boolean);

  return {
    port: parseInt(process.env.AF_PORT || '8787', 10),
    bind: process.env.AF_BIND || '127.0.0.1',
    bridgeToken,
    dataDir: process.env.AF_DATA_DIR || './data/sessions',
    allowedRoots,
    denyGlobs,
    promptAppend: process.env.AF_PROMPT_APPEND || '',
    maxConcurrent: parseInt(process.env.AF_MAX_CONCURRENT || '1', 10),
    turnsMaxCap: 50,
    timeoutSecondsCap: 1800,
    promptAppendMaxBytes: 2048,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/config.test.ts
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with env var parsing and validation"
```

---

### Task 3: Redaction module

**Files:**
- Create: `src/security/redaction.ts`
- Create: `tests/security/redaction.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/security/redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redact } from '../../src/security/redaction.js';

describe('redact', () => {
  // Block-level: PEM keys
  it('redacts PEM private key blocks', () => {
    const input = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...base64...\n-----END RSA PRIVATE KEY-----\nafter';
    const result = redact(input);
    expect(result).toContain('<REDACTED_PRIVATE_KEY_BLOCK>');
    expect(result).not.toContain('MIIE');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('redacts OpenSSH private key blocks', () => {
    const input = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r...\n-----END OPENSSH PRIVATE KEY-----';
    const result = redact(input);
    expect(result).toContain('<REDACTED_PRIVATE_KEY_BLOCK>');
    expect(result).not.toContain('b3BlbnNzaC1r');
  });

  it('redacts certificate blocks', () => {
    const input = '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----';
    const result = redact(input);
    expect(result).toContain('<REDACTED_CERT_BLOCK>');
  });

  // Token-level: API keys
  it('redacts OpenAI keys preserving prefix', () => {
    const input = 'key is sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234';
    const result = redact(input);
    expect(result).toContain('sk-***REDACTED***');
    expect(result).not.toContain('abc123');
  });

  it('redacts Anthropic keys preserving prefix', () => {
    const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789';
    const result = redact(input);
    expect(result).toContain('sk-ant-***REDACTED***');
  });

  it('redacts GitHub PATs preserving prefix', () => {
    const input = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh';
    const result = redact(input);
    expect(result).toContain('ghp_***REDACTED***');
  });

  it('redacts github_pat_ tokens', () => {
    const input = 'github_pat_abcdefghijklmnopqrstuvwx';
    const result = redact(input);
    expect(result).toContain('github_pat_***REDACTED***');
  });

  it('redacts Slack tokens preserving prefix', () => {
    const input = 'SLACK_TOKEN=xoxb-123456789-abcdefghij';
    const result = redact(input);
    expect(result).toContain('xoxb-***REDACTED***');
  });

  it('redacts JWTs', () => {
    const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redact(input);
    expect(result).toContain('<REDACTED_JWT>');
  });

  it('redacts AWS access keys', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redact(input);
    expect(result).toContain('AKIA***REDACTED***');
  });

  it('redacts Bearer tokens in Authorization headers', () => {
    const input = 'Authorization: Bearer sk-abc123def456ghi789jkl012';
    const result = redact(input);
    expect(result).not.toContain('abc123');
  });

  // KV-level
  it('redacts PASSWORD= values', () => {
    const input = 'PASSWORD=mysupersecretpassword';
    const result = redact(input);
    expect(result).toBe('PASSWORD=<REDACTED>');
  });

  it('redacts JSON "private_key" values', () => {
    const input = '"private_key": "-----BEGIN RSA PRIVATE KEY-----\\nMIIE..."';
    const result = redact(input);
    expect(result).toContain('"private_key": "<REDACTED>"');
  });

  it('redacts secret= values case-insensitively', () => {
    const input = 'CLIENT_SECRET=abcdef123456789';
    const result = redact(input);
    expect(result).toBe('CLIENT_SECRET=<REDACTED>');
  });

  // False-positive avoidance
  it('does NOT redact normal git SHA (40 hex chars)', () => {
    const input = 'commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const result = redact(input);
    expect(result).toBe(input);
  });

  it('does NOT redact UUIDs', () => {
    const input = 'session_id: 550e8400-e29b-41d4-a716-446655440000';
    const result = redact(input);
    expect(result).toBe(input);
  });

  it('does NOT redact short strings below min length', () => {
    const input = 'token=ab';
    const result = redact(input);
    expect(result).toBe(input);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/security/redaction.test.ts
```

Expected: FAIL -- module not found.

**Step 3: Implement redaction.ts**

```typescript
// src/security/redaction.ts

// Pass 1: Block-level patterns (PEM keys, certs)
const BLOCK_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '<REDACTED_PRIVATE_KEY_BLOCK>',
  },
  {
    pattern: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    replacement: '<REDACTED_CERT_BLOCK>',
  },
];

// Pass 2: Token-level patterns (API keys, JWTs)
const TOKEN_PATTERNS: Array<{ pattern: RegExp; replacer: (match: string) => string }> = [
  // JWT (must be before generic Bearer)
  { pattern: /eyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g, replacer: () => '<REDACTED_JWT>' },
  // Anthropic (must be before generic sk-)
  { pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g, replacer: () => 'sk-ant-***REDACTED***' },
  // OpenAI / generic sk-
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacer: () => 'sk-***REDACTED***' },
  // GitHub PAT (github_pat_)
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacer: () => 'github_pat_***REDACTED***' },
  // GitHub (ghp_, gho_, ghs_, ghr_)
  { pattern: /gh[posr]_[A-Za-z0-9]{36,}/g, replacer: (m) => `${m.slice(0, 4)}***REDACTED***` },
  // Slack
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacer: (m) => `${m.slice(0, 5)}***REDACTED***` },
  // AWS Access Key
  { pattern: /A[SK]IA[0-9A-Z]{16}/g, replacer: (m) => `${m.slice(0, 4)}***REDACTED***` },
];

// Pass 3: KV-level patterns (password=, secret=, etc.)
const KV_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JSON "key": "value"
  {
    pattern: /("(?:private_key|client_secret|secret_key|api_key|access_token|refresh_token)")\s*:\s*"[^"]+"/gi,
    replacement: '$1: "<REDACTED>"',
  },
  // ENV style KEY=value (only for sensitive key names, value must be 6+ chars)
  {
    pattern: /\b([A-Z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z_]*)=["']?([^"'\s]{6,})["']?/gi,
    replacement: '$1=<REDACTED>',
  },
];

export function redact(input: string): string {
  let result = input;

  // Pass 1: Block-level
  for (const { pattern, replacement } of BLOCK_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }

  // Pass 2: Token-level
  for (const { pattern, replacer } of TOKEN_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacer);
  }

  // Pass 3: KV-level
  for (const { pattern, replacement } of KV_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/security/redaction.test.ts
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add src/security/redaction.ts tests/security/redaction.test.ts
git commit -m "feat: add three-pass redaction pipeline (block/token/KV)"
```

---

### Task 4: PathGuard module

**Files:**
- Create: `src/security/pathGuard.ts`
- Create: `tests/security/pathGuard.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/security/pathGuard.test.ts
import { describe, it, expect } from 'vitest';
import { validatePath } from '../../src/security/pathGuard.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('validatePath', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pathguard-'));
  const allowedRoot = path.join(tmpRoot, 'allowed');
  const outsideDir = path.join(tmpRoot, 'outside');

  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(allowedRoot, 'file.ts'), 'content');
  fs.writeFileSync(path.join(allowedRoot, '.env'), 'SECRET=x');
  fs.mkdirSync(path.join(allowedRoot, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(allowedRoot, '.ssh', 'id_rsa'), 'key');
  fs.writeFileSync(path.join(allowedRoot, 'creds.pem'), 'cert');

  const denyGlobs = ['**/.env', '**/.ssh/**', '**/*.pem'];

  it('allows path under allowed root', () => {
    const result = validatePath(path.join(allowedRoot, 'file.ts'), [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(true);
  });

  it('rejects path outside all roots', () => {
    const result = validatePath(path.join(outsideDir, 'file.ts'), [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('rejects path with ../ traversal resolving outside root', () => {
    const result = validatePath(path.join(allowedRoot, '..', 'outside', 'file.ts'), [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
  });

  it('rejects path matching deny glob **/.env', () => {
    const result = validatePath(path.join(allowedRoot, '.env'), [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('deny glob');
  });

  it('rejects path matching deny glob **/.ssh/**', () => {
    const result = validatePath(path.join(allowedRoot, '.ssh', 'id_rsa'), [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
  });

  it('rejects path matching deny glob **/*.pem', () => {
    const result = validatePath(path.join(allowedRoot, 'creds.pem'), [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
  });

  it('rejects empty path', () => {
    const result = validatePath('', [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
  });

  it('rejects null-byte in path', () => {
    const result = validatePath('/tmp/foo\0bar', [allowedRoot], denyGlobs);
    expect(result.allowed).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/security/pathGuard.test.ts
```

**Step 3: Implement pathGuard.ts**

```typescript
// src/security/pathGuard.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import { minimatch } from 'minimatch';

export interface PathGuardResult {
  allowed: boolean;
  resolved?: string;
  reason?: string;
}

export function validatePath(
  targetPath: string,
  contextRoots: string[],
  denyGlobs: string[],
): PathGuardResult {
  if (!targetPath || targetPath.includes('\0')) {
    return { allowed: false, reason: 'Invalid path: empty or contains null byte' };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(targetPath));
  } catch {
    resolved = path.resolve(targetPath);
  }

  const underRoot = contextRoots.some(root => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });

  if (!underRoot) {
    return { allowed: false, resolved, reason: 'Path not under any allowed root' };
  }

  for (const root of contextRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolved.startsWith(resolvedRoot)) {
      const relative = path.relative(resolvedRoot, resolved);
      for (const glob of denyGlobs) {
        if (minimatch(relative, glob, { dot: true })) {
          return { allowed: false, resolved, reason: `Path matches deny glob: ${glob}` };
        }
      }
    }
  }

  return { allowed: true, resolved };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/security/pathGuard.test.ts
```

**Step 5: Commit**

```bash
git add src/security/pathGuard.ts tests/security/pathGuard.test.ts
git commit -m "feat: add pathGuard with context root + deny globs"
```

---

### Task 5: Policy module

**Files:**
- Create: `src/security/policy.ts`
- Create: `tests/security/policy.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/security/policy.test.ts
import { describe, it, expect } from 'vitest';
import { validateTaskInput } from '../../src/security/policy.js';
import type { Config } from '../../src/config.js';

const baseConfig: Config = {
  port: 8787, bind: '127.0.0.1', bridgeToken: 'test-token',
  dataDir: './data/sessions', allowedRoots: ['/tmp/allowed'],
  denyGlobs: ['**/.env'], promptAppend: '', maxConcurrent: 1,
  turnsMaxCap: 50, timeoutSecondsCap: 1800, promptAppendMaxBytes: 2048,
};

describe('validateTaskInput', () => {
  it('accepts valid input with defaults', () => {
    const result = validateTaskInput({ goal: 'Fix bug', workspace_root: '/tmp/allowed/proj' }, baseConfig);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.turns_max).toBe(20);
    expect(result.sanitized!.timeout_seconds).toBe(600);
  });

  it('rejects missing goal', () => {
    const result = validateTaskInput({ workspace_root: '/tmp/allowed/proj' } as any, baseConfig);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('goal is required');
  });

  it('rejects goal exceeding 4KB', () => {
    const result = validateTaskInput({ goal: 'a'.repeat(4097), workspace_root: '/tmp/proj' }, baseConfig);
    expect(result.valid).toBe(false);
  });

  it('caps turns_max at 50', () => {
    const result = validateTaskInput({ goal: 'Fix', workspace_root: '/tmp/proj', turns_max: 100 }, baseConfig);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.turns_max).toBe(50);
  });

  it('caps timeout_seconds at 1800', () => {
    const result = validateTaskInput({ goal: 'Fix', workspace_root: '/tmp/proj', timeout_seconds: 9999 }, baseConfig);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.timeout_seconds).toBe(1800);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/security/policy.test.ts
```

**Step 3: Implement policy.ts**

```typescript
// src/security/policy.ts
import type { Config } from '../config.js';

export interface TaskInput {
  goal: string;
  workspace_root: string;
  allowed_tools?: string[];
  turns_max?: number;
  timeout_seconds?: number;
}

export interface SanitizedTaskInput {
  goal: string;
  workspace_root: string;
  allowed_tools: string[];
  turns_max: number;
  timeout_seconds: number;
}

export interface ValidationResult {
  valid: boolean;
  sanitized?: SanitizedTaskInput;
  errors: string[];
}

const MAX_GOAL_BYTES = 4096;

export function validateTaskInput(input: any, config: Config): ValidationResult {
  const errors: string[] = [];

  if (!input || typeof input.goal !== 'string' || !input.goal.trim()) {
    errors.push('goal is required');
  } else if (Buffer.byteLength(input.goal, 'utf-8') > MAX_GOAL_BYTES) {
    errors.push('goal exceeds 4KB limit');
  }

  if (!input || typeof input.workspace_root !== 'string' || !input.workspace_root.trim()) {
    errors.push('workspace_root is required');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const turnsMax = Math.min(
    typeof input.turns_max === 'number' && input.turns_max > 0 ? input.turns_max : 20,
    config.turnsMaxCap,
  );

  const timeoutSeconds = Math.min(
    typeof input.timeout_seconds === 'number' && input.timeout_seconds > 0 ? input.timeout_seconds : 600,
    config.timeoutSecondsCap,
  );

  const allowedTools = Array.isArray(input.allowed_tools)
    ? input.allowed_tools.filter((t: any) => typeof t === 'string')
    : [];

  return {
    valid: true,
    sanitized: {
      goal: input.goal.trim(),
      workspace_root: input.workspace_root.trim(),
      allowed_tools: allowedTools,
      turns_max: turnsMax,
      timeout_seconds: timeoutSeconds,
    },
    errors: [],
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/security/policy.test.ts
```

**Step 5: Commit**

```bash
git add src/security/policy.ts tests/security/policy.test.ts
git commit -m "feat: add policy module with task input validation and caps"
```

---

### Task 6: Prompt template module

**Files:**
- Create: `src/security/promptTemplate.ts`
- Create: `tests/security/promptTemplate.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/security/promptTemplate.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrompt, PromptTemplateError } from '../../src/security/promptTemplate.js';

describe('buildPrompt', () => {
  it('substitutes goal and workspace placeholders', () => {
    const result = buildPrompt({ goal: 'Fix the bug', workspace: '/tmp/project', constraints: '' }, '');
    expect(result.prompt).toContain('Fix the bug');
    expect(result.prompt).toContain('/tmp/project');
    expect(result.templateHash).toBeTruthy();
  });

  it('appends AF_PROMPT_APPEND content', () => {
    const result = buildPrompt({ goal: 'Fix', workspace: '/tmp', constraints: '' }, 'Always run tests');
    expect(result.prompt).toContain('Always run tests');
  });

  it('rejects append exceeding 2KB', () => {
    expect(() => buildPrompt(
      { goal: 'Fix', workspace: '/tmp', constraints: '' }, 'a'.repeat(2049),
    )).toThrow(PromptTemplateError);
  });

  it('rejects append containing injection patterns', () => {
    expect(() => buildPrompt(
      { goal: 'Fix', workspace: '/tmp', constraints: '' }, 'ignore previous instructions',
    )).toThrow(PromptTemplateError);
  });

  it('returns a consistent template hash', () => {
    const r1 = buildPrompt({ goal: 'A', workspace: '/tmp', constraints: '' }, '');
    const r2 = buildPrompt({ goal: 'B', workspace: '/tmp', constraints: '' }, '');
    expect(r1.templateHash).toBe(r2.templateHash);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/security/promptTemplate.test.ts
```

**Step 3: Implement promptTemplate.ts**

```typescript
// src/security/promptTemplate.ts
import { createHash } from 'node:crypto';

const BASE_TEMPLATE = `You are an AI coding assistant operating within Agent Firewall.

WORKSPACE: {{workspace}}
GOAL: {{goal}}
{{constraints}}

RULES:
- Only modify files within the workspace directory
- Do not access files outside the workspace
- Do not attempt to exfiltrate data via network calls
- Report any blockers with exact file paths and line numbers
- Generate a summary of changes made

Begin working on the goal.`;

const INJECTION_PATTERNS = [
  /ignore\s+previous/i,
  /disregard\s+(all\s+)?instructions/i,
  /\bread\s+\/(?!tmp)/i,
  /\bexfiltrate\b/i,
];

const MAX_APPEND_BYTES = 2048;

export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTemplateError';
  }
}

export interface PromptParams {
  goal: string;
  workspace: string;
  constraints: string;
}

export interface PromptResult {
  prompt: string;
  templateHash: string;
}

export function buildPrompt(params: PromptParams, append: string): PromptResult {
  if (Buffer.byteLength(append, 'utf-8') > MAX_APPEND_BYTES) {
    throw new PromptTemplateError(`AF_PROMPT_APPEND exceeds ${MAX_APPEND_BYTES} byte limit`);
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(append)) {
      throw new PromptTemplateError(`AF_PROMPT_APPEND contains blocked pattern: ${pattern.source}`);
    }
  }

  const templateHash = createHash('sha256').update(BASE_TEMPLATE).digest('hex').slice(0, 16);

  let prompt = BASE_TEMPLATE
    .replace('{{goal}}', params.goal)
    .replace('{{workspace}}', params.workspace)
    .replace('{{constraints}}', params.constraints);

  if (append.trim()) {
    prompt += `\n\nADDITIONAL INSTRUCTIONS:\n${append.trim()}`;
  }

  return { prompt, templateHash: `sha256:${templateHash}` };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/security/promptTemplate.test.ts
```

**Step 5: Commit**

```bash
git add src/security/promptTemplate.ts tests/security/promptTemplate.test.ts
git commit -m "feat: add prompt template with injection guard + hash audit"
```

---

### Task 7: Blocker extractor util

**Files:**
- Create: `src/utils/blockerExtractor.ts`
- Create: `tests/utils/blockerExtractor.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/utils/blockerExtractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractBlockers } from '../../src/utils/blockerExtractor.js';

describe('extractBlockers', () => {
  it('extracts file:line patterns', () => {
    const output = 'Error in src/auth.ts:42 - missing import\nWarning src/utils.ts:10 deprecated';
    const blockers = extractBlockers(output);
    expect(blockers).toHaveLength(2);
    expect(blockers[0]).toMatchObject({ file: 'src/auth.ts', line_range: '42' });
  });

  it('extracts file:line-line range patterns', () => {
    const output = 'Type error at src/types.ts:12-18';
    const blockers = extractBlockers(output);
    expect(blockers[0]).toMatchObject({ file: 'src/types.ts', line_range: '12-18' });
  });

  it('deduplicates identical file+line', () => {
    const output = 'Error src/a.ts:5 first\nError src/a.ts:5 second';
    const blockers = extractBlockers(output);
    expect(blockers).toHaveLength(1);
  });

  it('caps at 10 blockers', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Error file${i}.ts:${i}`).join('\n');
    const blockers = extractBlockers(lines);
    expect(blockers).toHaveLength(10);
  });

  it('returns empty array when no matches', () => {
    const blockers = extractBlockers('Everything is fine, no errors.');
    expect(blockers).toEqual([]);
  });
});
```

**Step 2: Run tests, implement, run again**

Implementation:

```typescript
// src/utils/blockerExtractor.ts
export interface Blocker {
  description: string;
  file: string;
  line_range: string;
}

const MAX_BLOCKERS = 10;
const FILE_LINE_PATTERN = /([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(\d+(?:-\d+)?)/g;

export function extractBlockers(output: string): Blocker[] {
  const seen = new Set<string>();
  const blockers: Blocker[] = [];

  for (const match of output.matchAll(FILE_LINE_PATTERN)) {
    if (blockers.length >= MAX_BLOCKERS) break;

    const file = match[1];
    const lineRange = match[2];
    const key = `${file}:${lineRange}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const lineStart = output.lastIndexOf('\n', match.index!) + 1;
    const lineEnd = output.indexOf('\n', match.index!);
    const description = output.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

    blockers.push({ description, file, line_range: lineRange });
  }

  return blockers;
}
```

**Step 3: Commit**

```bash
git add src/utils/blockerExtractor.ts tests/utils/blockerExtractor.test.ts
git commit -m "feat: add blocker extractor (file:line pattern matching)"
```

---

### Task 8: Exec util (spawn + timeout + process group kill)

**Files:**
- Create: `src/utils/exec.ts`
- Create: `tests/utils/exec.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/utils/exec.test.ts
import { describe, it, expect } from 'vitest';
import { spawnWithTimeout } from '../../src/utils/exec.js';

describe('spawnWithTimeout', () => {
  it('captures stdout from a simple command', async () => {
    const result = await spawnWithTimeout('echo', ['hello'], { timeoutMs: 5000 });
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const result = await spawnWithTimeout('node', ['-e', 'console.error("err")'], { timeoutMs: 5000 });
    expect(result.stderr.trim()).toBe('err');
  });

  it('kills process on timeout', async () => {
    const result = await spawnWithTimeout('sleep', ['30'], { timeoutMs: 500, killGraceMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it('returns non-zero exit code on failure', async () => {
    const result = await spawnWithTimeout('node', ['-e', 'process.exit(42)'], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(42);
  });
});
```

**Step 2: Implement exec.ts**

Note: Uses `spawn` (not `exec`) with argument arrays -- no shell injection risk.

```typescript
// src/utils/exec.ts
import { spawn, ChildProcess } from 'node:child_process';

export interface SpawnOptions {
  timeoutMs: number;
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function spawnWithTimeout(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const killGraceMs = options.killGraceMs ?? 5000;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      options.onStdout?.(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      options.onStderr?.(chunk);
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, killGraceMs);
    }, options.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: err.message,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}

function killProcessGroup(child: ChildProcess, graceMs: number): void {
  if (!child.pid) return;

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }

  const graceTimeout = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // Already dead
    }
  }, graceMs);

  child.on('close', () => clearTimeout(graceTimeout));
}
```

**Step 3: Run tests, commit**

```bash
npx vitest run tests/utils/exec.test.ts
git add src/utils/exec.ts tests/utils/exec.test.ts
git commit -m "feat: add exec util with timeout + process group kill"
```

---

## Phase 3: Session Store

### Task 9: SessionStore interface + filesystem implementation

**Files:**
- Create: `src/sessions/types.ts`
- Create: `src/sessions/sessionStore.ts`
- Create: `tests/sessions/sessionStore.test.ts`

**Step 1: Create types.ts**

```typescript
// src/sessions/types.ts
export type SessionStatus = 'running' | 'done' | 'failed' | 'aborted';

export interface Blocker {
  description: string;
  file: string;
  line_range: string;
}

export interface ArtifactEntry {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface SharedState {
  session_id: string;
  goal: string;
  status: SessionStatus;
  turns_completed: number;
  turns_max: number;
  progress: string[];
  blockers: Blocker[];
  files_changed: string[];
  artifacts: string[];
  fallback_events: string[];
  updated_at: string;
  error_summary: string | null;
}

export interface TaskRecord {
  session_id: string;
  goal: string;
  workspace_root: string;
  allowed_tools: string[];
  turns_max: number;
  timeout_seconds: number;
  created_at: string;
  template_hash: string;
}

export interface SessionSummary {
  session_id: string;
  status: SessionStatus;
  goal: string;
  created_at: string;
  updated_at: string;
}
```

**Step 2: Write tests**

```typescript
// tests/sessions/sessionStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSessionStore } from '../../src/sessions/sessionStore.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeTask(id: string) {
  return {
    session_id: id, goal: 'Test', workspace_root: '/tmp',
    allowed_tools: [] as string[], turns_max: 20, timeout_seconds: 600,
    created_at: new Date().toISOString(), template_hash: 'sha256:abc',
  };
}

describe('FileSessionStore', () => {
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-store-'));
    store = new FileSessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates session with task.json and shared_state.json', async () => {
    await store.create('s1', makeTask('s1'));
    expect(fs.existsSync(path.join(tmpDir, 's1', 'task.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 's1', 'shared_state.json'))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 's1', 'shared_state.json'), 'utf-8'));
    expect(state.status).toBe('running');
  });

  it('getState returns state or null', async () => {
    await store.create('s2', makeTask('s2'));
    expect((await store.getState('s2'))?.status).toBe('running');
    expect(await store.getState('nonexistent')).toBeNull();
  });

  it('updateState patches fields', async () => {
    await store.create('s3', makeTask('s3'));
    await store.updateState('s3', { status: 'done', turns_completed: 5 });
    const state = await store.getState('s3');
    expect(state?.status).toBe('done');
    expect(state?.turns_completed).toBe(5);
  });

  it('listSessions returns summaries', async () => {
    await store.create('s4', makeTask('s4'));
    const list = await store.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].session_id).toBe('s4');
  });

  it('markAbortedOnStartup marks running as aborted', async () => {
    await store.create('s5', makeTask('s5'));
    await store.markAbortedOnStartup();
    const state = await store.getState('s5');
    expect(state?.status).toBe('aborted');
    expect(state?.error_summary).toContain('Server restarted');
  });

  it('getArtifactPath returns null for unknown artifact', async () => {
    await store.create('s6', makeTask('s6'));
    expect(await store.getArtifactPath('s6', '../../etc/passwd')).toBeNull();
  });
});
```

**Step 3: Implement sessionStore.ts**

(Implementation as described in design doc -- FileSessionStore class with all CRUD methods, using `node:fs/promises`)

**Step 4: Run tests, commit**

```bash
npx vitest run tests/sessions/sessionStore.test.ts
git add src/sessions/types.ts src/sessions/sessionStore.ts tests/sessions/sessionStore.test.ts
git commit -m "feat: add FileSessionStore with create/update/list/abort"
```

---

## Phase 4: Worker Layer

### Task 10: ConcurrencyGate

**Files:**
- Create: `src/workers/types.ts`
- Create: `src/workers/concurrencyGate.ts`
- Create: `tests/workers/concurrencyGate.test.ts`

**Step 1: Write tests**

```typescript
// tests/workers/concurrencyGate.test.ts
import { describe, it, expect } from 'vitest';
import { GlobalConcurrencyGate } from '../../src/workers/concurrencyGate.js';

describe('GlobalConcurrencyGate', () => {
  it('allows first acquire', () => {
    const gate = new GlobalConcurrencyGate();
    expect(gate.acquire('/tmp/proj', 'sess-1')).toBe(true);
    expect(gate.activeSessionId()).toBe('sess-1');
  });

  it('rejects second acquire', () => {
    const gate = new GlobalConcurrencyGate();
    gate.acquire('/tmp/proj', 'sess-1');
    expect(gate.acquire('/tmp/other', 'sess-2')).toBe(false);
  });

  it('allows acquire after release', () => {
    const gate = new GlobalConcurrencyGate();
    gate.acquire('/tmp/proj', 'sess-1');
    gate.release('/tmp/proj');
    expect(gate.activeSessionId()).toBeNull();
    expect(gate.acquire('/tmp/proj', 'sess-2')).toBe(true);
  });
});
```

**Step 2: Implement, test, commit**

```bash
git add src/workers/types.ts src/workers/concurrencyGate.ts tests/workers/concurrencyGate.test.ts
git commit -m "feat: add Worker interface + GlobalConcurrencyGate"
```

---

### Task 11: FilesChanged + Artifacts utils

**Files:**
- Create: `src/utils/filesChanged.ts`
- Create: `src/utils/artifacts.ts`
- Create: `tests/utils/filesChanged.test.ts`

(Tests verify git diff detection, non-git fallback, artifact index building with sha256)

**Commit:**

```bash
git commit -m "feat: add filesChanged (git diff) + artifact index builder"
```

---

### Task 12: ClaudeCodeWorker

**Files:**
- Create: `src/workers/claudeCode.ts`
- Create: `tests/workers/claudeCode.test.ts`

Core worker that spawns `claude --print` using `spawnWithTimeout` (not shell exec), collects output, extracts blockers, runs git diff, builds artifacts. Uses `spawn` with argument arrays only.

**Commit:**

```bash
git commit -m "feat: add ClaudeCodeWorker (spawn CLI, parse output, build artifacts)"
```

---

## Phase 5: HTTP Layer

### Task 13: Auth middleware

**Files:**
- Create: `src/middleware/auth.ts`
- Create: `tests/middleware/auth.test.ts`

```bash
git commit -m "feat: add Bearer token auth middleware"
```

---

### Task 14: Routes + Express app

**Files:**
- Create: `src/routes.ts`
- Modify: `src/index.ts`
- Create: `tests/routes.test.ts`

All 8 endpoints implemented. Key security checks:
- POST /v1/tasks: pathGuard on workspace_root against AF_ALLOWED_ROOTS
- GET excerpt: pathGuard scoped to session's workspace_root (not global roots)
- GET artifacts/:name: lookup in index only (no path joining)
- POST abort: SIGTERM via AbortController
- All output through `redact()`
- Startup: `markAbortedOnStartup()`

```bash
git commit -m "feat: add Express routes + server entry point with all endpoints"
```

---

## Phase 6: Container Isolation

### Task 15: Docker Compose + README

**Files:**
- Create: `docker-compose.yml`
- Create: `README.md`

```bash
git commit -m "feat: add docker-compose.yml + README with threat model and quick start"
```

---

## Phase 7: Acceptance Testing

### Task 16: Run 6 acceptance criteria

1. `curl POST /v1/tasks` -> 202 + session_id
2. Poll `GET /state` -> status running -> done/failed, blockers contain file + line_range
3. `GET /artifacts` -> index; download patch.diff
4. `POST /v1/tasks` with `workspace_root=~/.ssh` -> 403
5. No Authorization header -> 401
6. `docker compose up` -> container isolated but can reach API

```bash
git commit -m "test: add acceptance test script for 6 verification criteria"
```

---

## Summary

| Phase | Tasks | What you get |
|-------|-------|-------------|
| 1. Scaffolding | 1 | Empty TS project that builds |
| 2. Security modules | 2-8 | Config, redaction, pathGuard, policy, promptTemplate, blockerExtractor, exec |
| 3. Session store | 9 | FileSessionStore with full CRUD + abort recovery |
| 4. Worker layer | 10-12 | ConcurrencyGate, filesChanged, ClaudeCodeWorker |
| 5. HTTP layer | 13-14 | Auth middleware, all routes, Express app |
| 6. Container isolation | 15 | docker-compose.yml + README |
| 7. Acceptance | 16 | 6 curl-based acceptance tests passing |

**Total: 16 tasks, ~16 commits, bottom-up build order (leaves first, then composition).**
