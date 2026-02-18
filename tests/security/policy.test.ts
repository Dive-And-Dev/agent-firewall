import { describe, it, expect } from 'vitest';
import { validateTaskInput } from '../../src/security/policy.js';
import type { Config } from '../../src/config.js';

const baseConfig: Config = {
  port: 8787, bind: '127.0.0.1', bridgeToken: 'test-token',
  dataDir: './data/sessions', allowedRoots: ['/tmp/allowed'],
  denyGlobs: ['**/.env'], promptAppend: '', maxConcurrent: 1,
  turnsMaxCap: 50, timeoutSecondsCap: 1800, promptAppendMaxBytes: 2048,
  logtailMaxLines: 2000, excerptMaxChars: 100000,
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
    const result = validateTaskInput({ goal: 'a'.repeat(4097), workspace_root: '/tmp/allowed/proj' }, baseConfig);
    expect(result.valid).toBe(false);
  });

  // Note: allowed-root policy enforcement (→ 403) is handled by validatePath in app.ts,
  // not by validateTaskInput. validateTaskInput only validates input structure.

  it('caps turns_max at 50', () => {
    const result = validateTaskInput({ goal: 'Fix', workspace_root: '/tmp/allowed/proj', turns_max: 100 }, baseConfig);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.turns_max).toBe(50);
  });

  it('caps timeout_seconds at 1800', () => {
    const result = validateTaskInput({ goal: 'Fix', workspace_root: '/tmp/allowed/proj', timeout_seconds: 9999 }, baseConfig);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.timeout_seconds).toBe(1800);
  });
});
