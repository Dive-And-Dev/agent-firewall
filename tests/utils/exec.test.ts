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
