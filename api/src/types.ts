export interface Env {
  DB: D1Database;
  SESSION_KV: KVNamespace;
  JWT_SECRET: string;
}
export type ReservationStatus = 'reserved'|'calling'|'absent'|'accepted'|'entered'|'cancelled'|'expired';
export type CallQueueStatus   = 'waiting'|'calling'|'expiration_pending'|'recovery_calling'|'finished'|'expired';
export type EntryStatus       = 'waiting'|'calling'|'absent'|'completed'|'cancelled'|'expired';
export type UserRole          = 'developer'|'system_admin'|'user';
export type ScopedPermission  = 'project_manager'|'sheet_manager'|'staff'|'viewer';
export type TimeSlotStatus    = 'reservation_open'|'before_call'|'calling'|'in_progress'|'expiration_pending'|'expired';

export interface SessionPayload {
  userId: number; username: string; role: UserRole;
  accountType: 'personal'|'shared'; sheetId?: number;
  projectId?: number; permission?: ScopedPermission; exp: number;
}