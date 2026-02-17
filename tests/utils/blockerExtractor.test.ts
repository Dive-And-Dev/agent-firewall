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
