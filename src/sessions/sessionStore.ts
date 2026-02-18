import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SharedState, TaskRecord, SessionSummary } from './types.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session ID: must match ${SESSION_ID_PATTERN.source}`);
  }
}

export class FileSessionStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string) {}

  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = next.then(() => {}, () => {});
    this.locks.set(sessionId, cleanup);
    cleanup.then(() => {
      if (this.locks.get(sessionId) === cleanup) {
        this.locks.delete(sessionId);
      }
    });
    return next;
  }

  async create(sessionId: string, task: TaskRecord): Promise<void> {
    validateSessionId(sessionId);
    return this.withLock(sessionId, async () => {
      const dir = path.join(this.baseDir, sessionId);

      // Prevent overwriting existing sessions
      try {
        await fs.access(path.join(dir, 'task.json'));
        throw new Error(`Session ${sessionId} already exists`);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }

      await fs.mkdir(dir, { recursive: true });

    const initialState: SharedState = {
      session_id: sessionId,
      goal: task.goal,
      status: 'running',
      turns_completed: 0,
      turns_max: task.turns_max,
      progress: [],
      blockers: [],
      files_changed: [],
      artifacts: [],
      fallback_events: [],
      cost_usd: null,
      updated_at: new Date().toISOString(),
      error_summary: null,
    };

      await Promise.all([
        fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(task, null, 2)),
        fs.writeFile(path.join(dir, 'shared_state.json'), JSON.stringify(initialState, null, 2)),
      ]);
    });
  }

  async getState(sessionId: string): Promise<SharedState | null> {
    validateSessionId(sessionId);
    const filePath = path.join(this.baseDir, sessionId, 'shared_state.json');
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as SharedState;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async getTask(sessionId: string): Promise<TaskRecord | null> {
    validateSessionId(sessionId);
    const filePath = path.join(this.baseDir, sessionId, 'task.json');
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as TaskRecord;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async updateState(sessionId: string, patch: Partial<SharedState>): Promise<void> {
    validateSessionId(sessionId);
    return this.withLock(sessionId, async () => {
      const current = await this.getState(sessionId);
      if (!current) throw new Error(`Session ${sessionId} not found`);

      // Prevent mutation of identity fields
      const { session_id: _sid, goal: _goal, ...safePatch } = patch;

      const updated: SharedState = {
        ...current,
        ...safePatch,
        updated_at: new Date().toISOString(),
      };

      const filePath = path.join(this.baseDir, sessionId, 'shared_state.json');
      const tmpPath = filePath + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2));
      await fs.rename(tmpPath, filePath);
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.baseDir);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!SESSION_ID_PATTERN.test(entry)) continue;
      try {
        const state = await this.getState(entry);
        const task = await this.getTask(entry);
        if (state && task) {
          summaries.push({
            session_id: state.session_id,
            status: state.status,
            goal: state.goal,
            created_at: task.created_at,
            updated_at: state.updated_at,
          });
        }
      } catch {
        // Skip malformed sessions
      }
    }
    return summaries;
  }

  async markAbortedOnStartup(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.baseDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!SESSION_ID_PATTERN.test(entry)) continue;
      try {
        const state = await this.getState(entry);
        if (state && state.status === 'running') {
          await this.updateState(entry, {
            status: 'aborted',
            error_summary: 'Server restarted while session was running',
          });
        }
      } catch {
        // Skip malformed sessions
      }
    }
  }

  async getArtifactPath(
    sessionId: string,
    artifactName: string,
    workspaceRoot?: string,
  ): Promise<string | null> {
    validateSessionId(sessionId);
    // Prevent path traversal and directory access in artifact names
    if (!artifactName || artifactName === '.' || artifactName === '..' || artifactName.includes('/') || artifactName.includes('\\')) {
      return null;
    }
    const safe = path.basename(artifactName);
    if (safe !== artifactName) {
      return null;
    }

    // Artifacts live in workspace/.agent-firewall/artifacts/ when workspaceRoot is provided.
    // Fall back to session data dir for backwards-compat / tests.
    const artifactsDir = workspaceRoot
      ? path.join(workspaceRoot, '.agent-firewall', 'artifacts')
      : path.join(this.baseDir, sessionId, 'artifacts');
    const artifactPath = path.join(artifactsDir, safe);
    try {
      // Resolve symlinks and verify the real path is still under artifacts dir
      const realPath = await fs.realpath(artifactPath);
      const realDir = await fs.realpath(artifactsDir);
      if (!realPath.startsWith(realDir + path.sep)) {
        return null;
      }
      // Ensure it's a file, not a directory
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        return null;
      }
      return realPath;
    } catch {
      return null;
    }
  }
}
