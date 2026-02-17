import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Config } from '../config.js';

export interface TaskInput {
  goal: string;
  workspace_root: string;
  allowed_tools?: string[];
  turns_max?: number;
  timeout_seconds?: number;
}

export interface SanitizedTaskInput {
  goal: string;
  workspace_root: string;
  allowed_tools: string[];
  turns_max: number;
  timeout_seconds: number;
}

export interface ValidationResult {
  valid: boolean;
  sanitized?: SanitizedTaskInput;
  errors: string[];
}

const MAX_GOAL_BYTES = 4096;

function resolveRealPath(p: string): string {
  const absPath = path.resolve(p);
  try {
    return fs.realpathSync(absPath);
  } catch {
    // Walk up to nearest existing ancestor to resolve through symlinks
    let current = absPath;
    const tail: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      tail.unshift(path.basename(current));
      if (parent === current) return absPath;
      current = parent;
      try {
        return path.join(fs.realpathSync(current), ...tail);
      } catch {
        // Keep walking up
      }
    }
  }
}

export function validateTaskInput(input: any, config: Config): ValidationResult {
  const errors: string[] = [];

  if (!input || typeof input.goal !== 'string' || !input.goal.trim()) {
    errors.push('goal is required');
  } else if (Buffer.byteLength(input.goal, 'utf-8') > MAX_GOAL_BYTES) {
    errors.push('goal exceeds 4KB limit');
  }

  if (!input || typeof input.workspace_root !== 'string' || !input.workspace_root.trim()) {
    errors.push('workspace_root is required');
  } else {
    const resolvedWorkspace = resolveRealPath(input.workspace_root.trim());
    const underAllowedRoot = config.allowedRoots.some(root => {
      const resolvedRoot = resolveRealPath(root);
      if (resolvedWorkspace === resolvedRoot) return true;
      const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
      return resolvedWorkspace.startsWith(prefix);
    });
    if (!underAllowedRoot) {
      errors.push('workspace_root is not under any allowed root');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const turnsMax = Math.min(
    typeof input.turns_max === 'number' && input.turns_max > 0 ? input.turns_max : 20,
    config.turnsMaxCap,
  );

  const timeoutSeconds = Math.min(
    typeof input.timeout_seconds === 'number' && input.timeout_seconds > 0 ? input.timeout_seconds : 600,
    config.timeoutSecondsCap,
  );

  const allowedTools = Array.isArray(input.allowed_tools)
    ? input.allowed_tools.filter((t: any) => typeof t === 'string')
    : [];

  return {
    valid: true,
    sanitized: {
      goal: input.goal.trim(),
      workspace_root: resolveRealPath(input.workspace_root.trim()),
      allowed_tools: allowedTools,
      turns_max: turnsMax,
      timeout_seconds: timeoutSeconds,
    },
    errors: [],
  };
}
