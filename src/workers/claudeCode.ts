import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SharedState, ArtifactEntry, FallbackEvent } from '../sessions/types.js';
import type { Worker, WorkerResult } from './types.js';
import { spawnWithTimeout } from '../utils/exec.js';
import { redact } from '../security/redaction.js';
import { extractBlockers } from '../utils/blockerExtractor.js';
import { detectFilesChanged } from '../utils/filesChanged.js';
import { buildArtifactIndex } from '../utils/artifacts.js';

function isUnknownFlagError(stderr: string): boolean {
  return /unknown (option|flag)|unrecognized (option|flag)|not recognized|invalid (option|flag)/i.test(stderr);
}

// Returns true only if stderr specifically names the --allowedTools flag as problematic,
// so we don't misattribute a --output-format failure to this flag.
function isAllowedToolsRejected(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes('allowedtools') || s.includes('allowed-tools') || s.includes('allowed_tools');
}

async function generatePatchDiff(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const result = await spawnWithTimeout('git', ['diff', 'HEAD'], {
    timeoutMs: Math.min(timeoutMs, 10_000),
    cwd: workspaceRoot,
  });
  if (result.exitCode === 0) return result.stdout || '(no changes)\n';
  return '(git diff unavailable — workspace may not be a git repository)\n';
}

function buildSummaryMd(
  goal: string,
  turnsCompleted: number,
  costUsd: number | null,
  status: string,
  blockers: Array<{ description: string; file: string; line_range: string }>,
): string {
  const lines = [
    '# Task Summary',
    '',
    `**Goal:** ${goal}`,
    `**Status:** ${status}`,
    `**Turns completed:** ${turnsCompleted}`,
  ];
  if (costUsd !== null) lines.push(`**Cost (USD):** $${costUsd.toFixed(6)}`);
  if (blockers.length > 0) {
    lines.push('', '## Blockers', '');
    for (const b of blockers) {
      lines.push(`- **${b.file}:${b.line_range}** — ${b.description}`);
    }
  }
  lines.push('', '## Output', '', 'See `patch.diff` for workspace changes and `artifacts.json` for produced artifacts.');
  return lines.join('\n') + '\n';
}

function extractTestReport(output: string): string | null {
  const testLineRe = /\b(PASS|FAIL|passed|failed|✓|✗|×|●|Tests:|Test Suites:|test_results)\b/i;
  if (!testLineRe.test(output)) return null;
  const lines = output.split('\n').filter(l => testLineRe.test(l));
  if (lines.length === 0) return null;
  return `# Test Report\n\n\`\`\`\n${lines.slice(0, 100).join('\n')}\n\`\`\`\n`;
}

export class ClaudeCodeWorker implements Worker {
  async run(
    sessionId: string,
    goal: string,
    prompt: string,
    workspaceRoot: string,
    sessionDir: string,
    allowedTools: string[],
    timeoutMs: number,
    onProgress: (patch: Partial<SharedState>) => Promise<void>,
  ): Promise<WorkerResult> {
    const artifactsDir = path.join(workspaceRoot, '.agent-firewall', 'artifacts');
    const turnDir = path.join(sessionDir, 'turns', '0001');
    const outDir = path.join(sessionDir, 'out');

    await Promise.all([
      fs.mkdir(turnDir, { recursive: true }),
      fs.mkdir(outDir, { recursive: true }),
      fs.mkdir(artifactsDir, { recursive: true }).catch(() => {}),
    ]);

    // Build CLI args — prefer headless JSON output mode
    const baseArgs = ['-p', prompt, '--output-format', 'json'];
    const toolArgs = allowedTools.length > 0 ? ['--allowedTools', allowedTools.join(',')] : [];
    const fallbackEvents: FallbackEvent[] = [];

    const requestRecord = {
      goal,
      workspace_root: workspaceRoot,
      cli_flags: [...baseArgs.filter(a => a !== prompt), ...toolArgs],
      is_fallback: false,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(path.join(turnDir, 'request.json'), JSON.stringify(requestRecord, null, 2));

    // First attempt: full flags
    let spawnResult = await spawnWithTimeout('claude', [...baseArgs, ...toolArgs], {
      timeoutMs,
      cwd: workspaceRoot,
      env: { ...process.env, CLAUDE_SESSION_ID: sessionId },
    });

    // If --allowedTools specifically not recognized, retry without it.
    // We require the stderr to name this flag so we don't misattribute a
    // --output-format failure to --allowedTools and incorrectly drop tool restrictions.
    if (toolArgs.length > 0 && spawnResult.exitCode !== 0 && isUnknownFlagError(spawnResult.stderr) && isAllowedToolsRejected(spawnResult.stderr)) {
      fallbackEvents.push({
        time: new Date().toISOString(),
        attempted_flag: '--allowedTools',
        reason: spawnResult.stderr.slice(0, 300),
        fallback_action: 'retry without --allowedTools',
      });
      spawnResult = await spawnWithTimeout('claude', baseArgs, {
        timeoutMs,
        cwd: workspaceRoot,
        env: { ...process.env, CLAUDE_SESSION_ID: sessionId },
      });
    }

    // If --output-format json not recognized, retry in plain --print mode
    if (spawnResult.exitCode !== 0 && isUnknownFlagError(spawnResult.stderr)) {
      const alreadyDroppedTools = fallbackEvents.some(e => e.attempted_flag === '--allowedTools');
      const plainArgs = ['--print', prompt, ...(alreadyDroppedTools ? [] : toolArgs)];
      fallbackEvents.push({
        time: new Date().toISOString(),
        attempted_flag: '--output-format',
        reason: spawnResult.stderr.slice(0, 300),
        fallback_action: 'retry with --print (no --output-format json)',
      });
      spawnResult = await spawnWithTimeout('claude', plainArgs, {
        timeoutMs,
        cwd: workspaceRoot,
        env: { ...process.env, CLAUDE_SESSION_ID: sessionId },
      });
    }

    if (fallbackEvents.length > 0) {
      await fs.writeFile(
        path.join(turnDir, 'request.json'),
        JSON.stringify({ ...requestRecord, is_fallback: true }, null, 2),
      );
    }

    // Write raw (unredacted) logs for the audit trail.
    // Per spec: stdout.log/stderr.log must be the unredacted source of truth so that
    // operators can reconstruct exactly what the CLI produced. These files are stored
    // in AF_DATA_DIR which must be protected by OS filesystem permissions (not world-readable).
    // Redaction is applied at the API boundary (logtail/excerpt endpoints) — never here.
    await Promise.all([
      fs.writeFile(path.join(turnDir, 'stdout.log'), spawnResult.stdout),
      fs.writeFile(path.join(turnDir, 'stderr.log'), spawnResult.stderr),
    ]);

    // Try to parse JSON output (available when --output-format json succeeded)
    let cliOutput: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(spawnResult.stdout);
      if (parsed && typeof parsed === 'object') {
        cliOutput = parsed as Record<string, unknown>;
        await fs.writeFile(path.join(turnDir, 'cli_output.json'), spawnResult.stdout);
      }
    } catch {
      // Not JSON — normal for --print mode
    }

    const turnsCompleted = Number(cliOutput?.turn_count ?? cliOutput?.turns_completed ?? 1);
    const rawCost = cliOutput?.cost_usd ?? (cliOutput?.usage as Record<string, unknown> | undefined)?.cost;
    const costUsd = rawCost != null ? Number(rawCost) : null;

    // Build redacted composite for blocker extraction; raw logs stay on disk unredacted
    const rawOutput = spawnResult.stdout + (spawnResult.stderr ? '\n--- stderr ---\n' + spawnResult.stderr : '');
    const redactedOutput = redact(rawOutput);
    const blockers = extractBlockers(redactedOutput).slice(0, 10);

    await onProgress({ turns_completed: turnsCompleted, blockers });

    // Gather workspace artefacts in parallel with patch generation
    const [filesChanged, artifacts, patchDiff] = await Promise.all([
      detectFilesChanged(workspaceRoot),
      buildArtifactIndex(artifactsDir),
      generatePatchDiff(workspaceRoot, timeoutMs),
    ]);

    const status = spawnResult.timedOut ? 'failed' : spawnResult.exitCode === 0 ? 'done' : 'failed';
    const testReport = extractTestReport(spawnResult.stdout + '\n' + spawnResult.stderr);

    const writes: Promise<void>[] = [
      fs.writeFile(path.join(outDir, 'patch.diff'), patchDiff),
      fs.writeFile(path.join(outDir, 'summary.md'), buildSummaryMd(goal, turnsCompleted, costUsd, status, blockers)),
      fs.writeFile(path.join(outDir, 'artifacts.json'), JSON.stringify({ artifacts }, null, 2)),
    ];
    if (testReport) writes.push(fs.writeFile(path.join(outDir, 'test_report.md'), testReport));
    await Promise.all(writes);

    return {
      raw_output: rawOutput,
      redacted_output: redactedOutput,
      exit_code: spawnResult.exitCode,
      timed_out: spawnResult.timedOut,
      turns_completed: turnsCompleted,
      cost_usd: costUsd,
      blockers,
      files_changed: filesChanged,
      artifacts,
      fallback_events: fallbackEvents,
    };
  }
}
