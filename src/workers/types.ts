import type { SharedState, ArtifactEntry, FallbackEvent } from '../sessions/types.js';

export interface WorkerResult {
  raw_output: string;
  redacted_output: string;
  exit_code: number | null;
  timed_out: boolean;
  turns_completed: number;
  cost_usd: number | null;
  blockers: Array<{ description: string; file: string; line_range: string }>;
  files_changed: string[];
  artifacts: ArtifactEntry[];
  fallback_events: FallbackEvent[];
}

export interface Worker {
  run(
    sessionId: string,
    goal: string,
    prompt: string,
    workspaceRoot: string,
    sessionDir: string,
    allowedTools: string[],
    timeoutMs: number,
    onProgress: (patch: Partial<SharedState>) => Promise<void>,
  ): Promise<WorkerResult>;
}
