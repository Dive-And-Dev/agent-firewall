import type { SharedState } from '../sessions/types.js';

export interface WorkerResult {
  raw_output: string;
  redacted_output: string;
  exit_code: number | null;
  timed_out: boolean;
  blockers: Array<{ description: string; file: string; line_range: string }>;
  files_changed: string[];
  artifacts: Array<{ name: string; path: string; bytes: number; sha256: string }>;
}

export interface Worker {
  run(
    sessionId: string,
    goal: string,
    prompt: string,
    workspaceRoot: string,
    timeoutMs: number,
    onProgress: (patch: Partial<SharedState>) => Promise<void>,
  ): Promise<WorkerResult>;
}
