import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildArtifactIndex } from '../../src/utils/artifacts.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('buildArtifactIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-art-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds index with sha256 and size', async () => {
    const artifactsDir = path.join(tmpDir, 'artifacts');
    fs.mkdirSync(artifactsDir);
    fs.writeFileSync(path.join(artifactsDir, 'output.txt'), 'hello world');
    fs.writeFileSync(path.join(artifactsDir, 'data.json'), '{"key": "value"}');

    const index = await buildArtifactIndex(artifactsDir);
    expect(index).toHaveLength(2);

    const outputEntry = index.find(a => a.name === 'output.txt');
    expect(outputEntry).toBeDefined();
    expect(outputEntry!.bytes).toBe(11); // 'hello world'.length
    expect(outputEntry!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns empty array for missing directory', async () => {
    const index = await buildArtifactIndex(path.join(tmpDir, 'nope'));
    expect(index).toEqual([]);
  });

  it('skips subdirectories', async () => {
    const artifactsDir = path.join(tmpDir, 'artifacts');
    fs.mkdirSync(artifactsDir);
    fs.mkdirSync(path.join(artifactsDir, 'subdir'));
    fs.writeFileSync(path.join(artifactsDir, 'file.txt'), 'ok');

    const index = await buildArtifactIndex(artifactsDir);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('file.txt');
  });
});
