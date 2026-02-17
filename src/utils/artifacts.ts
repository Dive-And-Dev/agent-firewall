import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface ArtifactEntry {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Build an artifact index from files in the given directory.
 * Only includes regular files (skips subdirectories).
 * Returns empty array if directory doesn't exist.
 */
export async function buildArtifactIndex(artifactsDir: string): Promise<ArtifactEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(artifactsDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const artifacts: ArtifactEntry[] = [];

  for (const entry of entries) {
    const fullPath = path.join(artifactsDir, entry);
    const lstat = await fs.lstat(fullPath);
    if (!lstat.isFile() || lstat.isSymbolicLink()) continue;

    const content = await fs.readFile(fullPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    artifacts.push({
      name: entry,
      path: fullPath,
      bytes: lstat.size,
      sha256: hash,
    });
  }

  return artifacts;
}
