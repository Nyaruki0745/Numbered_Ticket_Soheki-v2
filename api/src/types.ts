// ============================================================
// Cloudflare Workers バインディング
// ============================================================
export interface Env {
  JWT_SECRET: string;
  DB: D1Database;
  SESSION_KV: KVNamespace;
}

// ============================================================
// DB 行型
// ============================================================
export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'suspended' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface SheetRow {
  id: number;
  project_id: number;
  name: string;
  ticket_prefix: string;
  ticket_digits: number;
  ticket_next_number: number;
  entry_enabled: 0 | 1;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TimeSlotRow {
  id: number;
  sheet_id: number;
  name: string;
  start_at: string;
  end_at: string;
  capacity_groups: number;
  call_start_at: string;
  call_end_at: string;
  expire_at: string;
  sort_order: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export type ReservationStatus =
  | 'reserved' | 'calling' | 'absent'
  | 'accepted' | 'entered' | 'cancelled' | 'expired';

export interface ReservationRow {
  id: number;
  sheet_id: number;
  time_slot_id: number;
  ticket_number: number;
  ticket_code: string;
  group_size: number;
  status: ReservationStatus;
  reserved_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancel_token_hash: string | null;
}

export type CallQueueStatus =
  | 'waiting' | 'calling' | 'expiration_pending'
  | 'recovery_calling' | 'finished' | 'expired';

export interface CallQueueRow {
  id: number;
  time_slot_id: number;
  status: CallQueueStatus;
  current_entry_id: number | null;
  created_at: string;
  updated_at: string;
}

export type EntryStatus =
  | 'waiting' | 'calling' | 'absent'
  | 'completed' | 'cancelled' | 'expired';

export interface CallQueueEntryRow {
  id: number;
  queue_id: number;
  reservation_id: number;
  queue_type: 'normal' | 'recovery';
  queue_seq: number | null;
  recovery_seq: number | null;
  status: EntryStatus;
  called_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export type UserRole = 'developer' | 'system_admin' | 'user';
export type ScopedPermission = 'project_manager' | 'sheet_manager' | 'staff' | 'viewer';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  account_type: 'personal' | 'shared';
  display_name: string;
  role: UserRole;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UserSheetPermissionRow {
  id: number;
  user_id: number;
  sheet_id: number;
  permission: ScopedPermission;
  created_at: string;
}

export interface UserProjectPermissionRow {
  id: number;
  user_id: number;
  project_id: number;
  permission: 'project_manager' | 'viewer';
  created_at: string;
}

export interface SheetNoticeRow {
  id: number;
  sheet_id: number;
  screen_type: string;
  title: string | null;
  body: string;
  sort_order: number;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

export interface DisplayConfigRow {
  id: number;
  project_id: number;
  name: string;
  display_key: string;
  display_slot: 1 | 2;
  display_type: string;
  current_scene_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SceneRow {
  id: number;
  sheet_id: number;
  name: string;
  description: string | null;
  status: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface AuditLogRow {
  id: number;
  actor_type: string;
  user_id: number | null;
  sheet_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  details_json: string | null;
  created_at: string;
}

// ============================================================
// API レスポンス型
// ============================================================
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiError   = { ok: false; error: { code: string; message: string; details?: unknown } };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ============================================================
// セッション
// ============================================================
export interface SessionPayload {
  userId: number;
  username: string;
  role: UserRole;
  accountType: 'personal' | 'shared';
  sheetId?: number;   // 共有スタッフアカウントのスコープ
  projectId?: number;
  permission?: ScopedPermission;
  exp: number;
}

// ============================================================
// 時間帯ステータス（画面設計 v0.5 §12 正規定義）
// ============================================================
export type TimeSlotStatus =
  | 'reservation_open'
  | 'before_call'
  | 'calling'
  | 'in_progress'
  | 'expiration_pending'
  | 'expired';
