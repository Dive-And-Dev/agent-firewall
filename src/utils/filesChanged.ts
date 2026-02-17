import { spawnWithTimeout } from './exec.js';

/**
 * Detect files changed in a git workspace since HEAD.
 * Returns relative file paths. Falls back to empty array for non-git directories.
 */
export async function detectFilesChanged(workspaceRoot: string): Promise<string[]> {
  // Detect tracked modifications + untracked files
  const [diffResult, untrackedResult] = await Promise.all([
    spawnWithTimeout('git', ['diff', '--name-only', 'HEAD'], {
      timeoutMs: 10_000,
      cwd: workspaceRoot,
    }),
    spawnWithTimeout('git', ['ls-files', '--others', '--exclude-standard'], {
      timeoutMs: 10_000,
      cwd: workspaceRoot,
    }),
  ]);

  // Non-git directory or git error — return empty
  if (diffResult.exitCode !== 0 || untrackedResult.exitCode !== 0) {
    return [];
  }

  const files = new Set<string>();

  for (const line of diffResult.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }

  for (const line of untrackedResult.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }

  return [...files];
}
