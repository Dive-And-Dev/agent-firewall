import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSessionStore } from '../../src/sessions/sessionStore.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeTask(id: string) {
  return {
    session_id: id, goal: 'Test', workspace_root: '/tmp',
    allowed_tools: [] as string[], turns_max: 20, timeout_seconds: 600,
    created_at: new Date().toISOString(), template_hash: 'sha256:abc',
  };
}

describe('FileSessionStore', () => {
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-store-'));
    store = new FileSessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates session with task.json and shared_state.json', async () => {
    await store.create('s1', makeTask('s1'));
    expect(fs.existsSync(path.join(tmpDir, 's1', 'task.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 's1', 'shared_state.json'))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 's1', 'shared_state.json'), 'utf-8'));
    expect(state.status).toBe('running');
  });

  it('getState returns state or null', async () => {
    await store.create('s2', makeTask('s2'));
    expect((await store.getState('s2'))?.status).toBe('running');
    expect(await store.getState('nonexistent')).toBeNull();
  });

  it('updateState patches fields', async () => {
    await store.create('s3', makeTask('s3'));
    await store.updateState('s3', { status: 'done', turns_completed: 5 });
    const state = await store.getState('s3');
    expect(state?.status).toBe('done');
    expect(state?.turns_completed).toBe(5);
  });

  it('listSessions returns summaries', async () => {
    await store.create('s4', makeTask('s4'));
    const list = await store.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].session_id).toBe('s4');
  });

  it('markAbortedOnStartup marks running as aborted', async () => {
    await store.create('s5', makeTask('s5'));
    await store.markAbortedOnStartup();
    const state = await store.getState('s5');
    expect(state?.status).toBe('aborted');
    expect(state?.error_summary).toContain('Server restarted');
  });

  it('getArtifactPath returns null for unknown artifact', async () => {
    await store.create('s6', makeTask('s6'));
    expect(await store.getArtifactPath('s6', '../../etc/passwd')).toBeNull();
  });
});
