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

  it('allows acquire after release by owner', () => {
    const gate = new GlobalConcurrencyGate();
    gate.acquire('/tmp/proj', 'sess-1');
    gate.release('/tmp/proj', 'sess-1');
    expect(gate.activeSessionId()).toBeNull();
    expect(gate.acquire('/tmp/proj', 'sess-2')).toBe(true);
  });

  it('ignores release from non-owner session', () => {
    const gate = new GlobalConcurrencyGate();
    gate.acquire('/tmp/proj', 'sess-1');
    gate.release('/tmp/proj', 'sess-2'); // wrong session
    expect(gate.activeSessionId()).toBe('sess-1'); // still locked
  });

  it('release is idempotent for unknown workspace', () => {
    const gate = new GlobalConcurrencyGate();
    gate.release('/tmp/nonexistent', 'sess-1');
    expect(gate.activeSessionId()).toBeNull();
  });
});
