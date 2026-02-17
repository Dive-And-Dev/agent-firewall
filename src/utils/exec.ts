import { spawn, ChildProcess } from 'node:child_process';

export interface SpawnOptions {
  timeoutMs: number;
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function spawnWithTimeout(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const killGraceMs = options.killGraceMs ?? 5000;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      options.onStdout?.(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      options.onStderr?.(chunk);
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessGroup(child, killGraceMs);
    }, options.timeoutMs);

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: err.message,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}

function killProcessGroup(child: ChildProcess, graceMs: number): void {
  if (!child.pid) return;

  // Try process group kill first (POSIX), fall back to direct child kill (Windows)
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }

  const graceTimeout = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }
  }, graceMs);

  child.on('close', () => clearTimeout(graceTimeout));
}
