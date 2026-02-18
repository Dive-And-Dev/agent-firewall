export type SessionStatus = 'running' | 'done' | 'failed' | 'aborted';

export interface Blocker {
  description: string;
  file: string;
  line_range: string;
}

export interface ArtifactEntry {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface FallbackEvent {
  time: string;
  attempted_flag: string;
  reason: string;
  fallback_action: string;
}

export interface SharedState {
  session_id: string;
  goal: string;
  status: SessionStatus;
  turns_completed: number;
  turns_max: number;
  progress: string[];
  blockers: Blocker[];
  files_changed: string[];
  artifacts: ArtifactEntry[];
  fallback_events: FallbackEvent[];
  cost_usd: number | null;
  updated_at: string;
  error_summary: string | null;
}

export interface TaskRecord {
  session_id: string;
  goal: string;
  workspace_root: string;
  allowed_tools: string[];
  turns_max: number;
  timeout_seconds: number;
  created_at: string;
  template_hash: string;
}

export interface SessionSummary {
  session_id: string;
  status: SessionStatus;
  goal: string;
  created_at: string;
  updated_at: string;
}
