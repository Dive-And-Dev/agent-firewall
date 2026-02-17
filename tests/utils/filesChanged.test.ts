import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectFilesChanged } from '../../src/utils/filesChanged.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

describe('detectFilesChanged', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-git-'));
    // Test setup only — hardcoded commands, no user input
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    // Create initial commit so HEAD exists
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects new and modified files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'hello');
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'modified');
    const files = await detectFilesChanged(tmpDir);
    expect(files).toContain('new.txt');
    expect(files).toContain('init.txt');
  });

  it('returns empty array when no changes', async () => {
    const files = await detectFilesChanged(tmpDir);
    expect(files).toEqual([]);
  });

  it('returns empty array for non-git directory', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'af-nogit-'));
    try {
      const files = await detectFilesChanged(nonGit);
      expect(files).toEqual([]);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
