import * as path from 'node:path';
import * as fs from 'node:fs';
import { minimatch } from 'minimatch';

export interface PathGuardResult {
  allowed: boolean;
  resolved?: string;
  reason?: string;
}

/**
 * Resolve a path through symlinks, walking up to the nearest existing ancestor
 * if the path itself doesn't exist yet (e.g., for create/write operations).
 */
function resolveWithAncestors(targetPath: string): string {
  const absPath = path.resolve(targetPath);
  try {
    return fs.realpathSync(absPath);
  } catch {
    // Walk up until we find an existing directory, then re-append the tail
    let current = absPath;
    const tail: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      tail.unshift(path.basename(current));
      if (parent === current) {
        // Reached filesystem root without finding an existing dir
        return absPath;
      }
      current = parent;
      try {
        const resolvedParent = fs.realpathSync(current);
        return path.join(resolvedParent, ...tail);
      } catch {
        // Keep walking up
      }
    }
  }
}

function resolveRoot(root: string): string {
  try {
    return fs.realpathSync(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

function isUnderRoot(resolved: string, resolvedRoot: string): boolean {
  if (resolved === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolved.startsWith(prefix);
}

export function validatePath(
  targetPath: string,
  contextRoots: string[],
  denyGlobs: string[],
): PathGuardResult {
  if (!targetPath || targetPath.includes('\0')) {
    return { allowed: false, reason: 'Invalid path: empty or contains null byte' };
  }

  const resolved = resolveWithAncestors(targetPath);

  const underRoot = contextRoots.some(root => isUnderRoot(resolved, resolveRoot(root)));

  if (!underRoot) {
    return { allowed: false, resolved, reason: 'Path not under any allowed root' };
  }

  for (const root of contextRoots) {
    const rr = resolveRoot(root);
    if (isUnderRoot(resolved, rr)) {
      const relative = path.relative(rr, resolved).split(path.sep).join('/');
      for (const glob of denyGlobs) {
        if (minimatch(relative, glob, { dot: true })) {
          return { allowed: false, resolved, reason: `Path matches deny glob: ${glob}` };
        }
      }
    }
  }

  return { allowed: true, resolved };
}
