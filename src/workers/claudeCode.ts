import * as path from 'node:path';
import type { SharedState } from '../sessions/types.js';
import type { Worker, WorkerResult } from './types.js';
import { spawnWithTimeout } from '../utils/exec.js';
import { redact } from '../security/redaction.js';
import { extractBlockers } from '../utils/blockerExtractor.js';
import { detectFilesChanged } from '../utils/filesChanged.js';
import { buildArtifactIndex } from '../utils/artifacts.js';

export class ClaudeCodeWorker implements Worker {
  async run(
    sessionId: string,
    goal: string,
    prompt: string,
    workspaceRoot: string,
    timeoutMs: number,
    onProgress: (patch: Partial<SharedState>) => Promise<void>,
  ): Promise<WorkerResult> {
    const artifactsDir = path.join(workspaceRoot, '.agent-firewall', 'artifacts');

    // Spawn claude CLI — no shell, argument array only
    const spawnResult = await spawnWithTimeout(
      'claude',
      ['--print', prompt],
      {
        timeoutMs,
        cwd: workspaceRoot,
        env: {
          ...process.env,
          CLAUDE_SESSION_ID: sessionId,
        },
      },
    );

    const rawOutput = spawnResult.stdout + (spawnResult.stderr ? '\n--- stderr ---\n' + spawnResult.stderr : '');
    const redactedOutput = redact(rawOutput);
    const blockers = extractBlockers(redactedOutput);

    // Notify progress with redacted output
    await onProgress({
      turns_completed: 1,
      blockers,
    });

    // Detect workspace changes and build artifact index
    const [filesChanged, artifacts] = await Promise.all([
      detectFilesChanged(workspaceRoot),
      buildArtifactIndex(artifactsDir),
    ]);

    return {
      raw_output: rawOutput,
      redacted_output: redactedOutput,
      exit_code: spawnResult.exitCode,
      timed_out: spawnResult.timedOut,
      blockers,
      files_changed: filesChanged,
      artifacts,
    };
  }
}
