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
