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
