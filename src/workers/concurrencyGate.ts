/**
 * Global concurrency gate — ensures only one agent session is active at a time.
 * Synchronous, in-memory. No disk I/O.
 */
export class GlobalConcurrencyGate {
  private currentSessionId: string | null = null;
  private currentWorkspace: string | null = null;

  acquire(workspace: string, sessionId: string): boolean {
    if (this.currentSessionId !== null) {
      return false;
    }
    this.currentSessionId = sessionId;
    this.currentWorkspace = workspace;
    return true;
  }

  release(workspace: string, sessionId: string): void {
    if (this.currentWorkspace === workspace && this.currentSessionId === sessionId) {
      this.currentSessionId = null;
      this.currentWorkspace = null;
    }
  }

  activeSessionId(): string | null {
    return this.currentSessionId;
  }
}
