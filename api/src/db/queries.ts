import type {
  Env, ProjectRow, SheetRow, TimeSlotRow,
  ReservationRow, CallQueueRow, CallQueueEntryRow,
  UserRow, UserSheetPermissionRow, UserProjectPermissionRow,
  SheetNoticeRow, AuditLogRow,
} from '../types';

// ============================================================
// 汎用ヘルパー
// ============================================================
export function now(): string {
  return new Date().toISOString();
}

// ============================================================
// projects
// ============================================================
export async function getProject(db: D1Database, id: number): Promise<ProjectRow | null> {
  const r = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  return r ?? null;
}

// ============================================================
// sheets
// ============================================================
export async function getSheet(db: D1Database, id: number): Promise<SheetRow | null> {
  const r = await db.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first<SheetRow>();
  return r ?? null;
}

export async function getSheetsByProject(db: D1Database, projectId: number): Promise<SheetRow[]> {
  const r = await db.prepare('SELECT * FROM sheets WHERE project_id = ? ORDER BY id').bind(projectId).all<SheetRow>();
  return r.results;
}

// ============================================================
// time_slots
// ============================================================
export async function getTimeSlot(db: D1Database, id: number): Promise<TimeSlotRow | null> {
  const r = await db.prepare('SELECT * FROM time_slots WHERE id = ?').bind(id).first<TimeSlotRow>();
  return r ?? null;
}

export async function getTimeSlotsBySheet(db: D1Database, sheetId: number): Promise<TimeSlotRow[]> {
  const r = await db.prepare(
    'SELECT * FROM time_slots WHERE sheet_id = ? ORDER BY start_at'
  ).bind(sheetId).all<TimeSlotRow>();
  return r.results;
}

// 時間帯の予約数（定員チェック用）
export async function countReservations(db: D1Database, timeSlotId: number): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) as cnt FROM reservations
     WHERE time_slot_id = ? AND status NOT IN ('cancelled','expired')`
  ).bind(timeSlotId).first<{ cnt: number }>();
  return r?.cnt ?? 0;
}

// ============================================================
// reservations
// ============================================================
export async function getReservation(db: D1Database, id: number): Promise<ReservationRow | null> {
  const r = await db.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first<ReservationRow>();
  return r ?? null;
}

export async function getReservationByCode(db: D1Database, ticketCode: string): Promise<ReservationRow | null> {
  const r = await db.prepare(
    'SELECT * FROM reservations WHERE ticket_code = ?'
  ).bind(ticketCode).first<ReservationRow>();
  return r ?? null;
}

// ============================================================
// call_queues
// ============================================================
export async function getCallQueueByTimeSlot(db: D1Database, timeSlotId: number): Promise<CallQueueRow | null> {
  const r = await db.prepare(
    'SELECT * FROM call_queues WHERE time_slot_id = ?'
  ).bind(timeSlotId).first<CallQueueRow>();
  return r ?? null;
}

export async function getCallQueue(db: D1Database, id: number): Promise<CallQueueRow | null> {
  const r = await db.prepare('SELECT * FROM call_queues WHERE id = ?').bind(id).first<CallQueueRow>();
  return r ?? null;
}

// ============================================================
// call_queue_entries
// ============================================================
export async function getEntry(db: D1Database, id: number): Promise<CallQueueEntryRow | null> {
  const r = await db.prepare('SELECT * FROM call_queue_entries WHERE id = ?').bind(id).first<CallQueueEntryRow>();
  return r ?? null;
}

export async function getCallingEntry(db: D1Database, queueId: number): Promise<CallQueueEntryRow | null> {
  const r = await db.prepare(
    `SELECT * FROM call_queue_entries
     WHERE queue_id = ? AND status = 'calling' LIMIT 1`
  ).bind(queueId).first<CallQueueEntryRow>();
  return r ?? null;
}

export async function getNextNormalEntry(db: D1Database, queueId: number): Promise<CallQueueEntryRow | null> {
  const r = await db.prepare(
    `SELECT * FROM call_queue_entries
     WHERE queue_id = ? AND queue_type = 'normal' AND status = 'waiting'
     ORDER BY queue_seq ASC LIMIT 1`
  ).bind(queueId).first<CallQueueEntryRow>();
  return r ?? null;
}

export async function getNextRecoveryEntry(db: D1Database, queueId: number): Promise<CallQueueEntryRow | null> {
  const r = await db.prepare(
    `SELECT * FROM call_queue_entries
     WHERE queue_id = ? AND queue_type = 'recovery' AND status = 'waiting'
     ORDER BY recovery_seq ASC LIMIT 1`
  ).bind(queueId).first<CallQueueEntryRow>();
  return r ?? null;
}

export async function hasNormalWaiting(db: D1Database, queueId: number): Promise<boolean> {
  const r = await db.prepare(
    `SELECT COUNT(*) as cnt FROM call_queue_entries
     WHERE queue_id = ? AND queue_type = 'normal' AND status = 'waiting'`
  ).bind(queueId).first<{ cnt: number }>();
  return (r?.cnt ?? 0) > 0;
}

export async function getMaxQueueSeq(db: D1Database, queueId: number): Promise<number> {
  const r = await db.prepare(
    `SELECT MAX(queue_seq) as mx FROM call_queue_entries
     WHERE queue_id = ? AND queue_type = 'normal'`
  ).bind(queueId).first<{ mx: number | null }>();
  return r?.mx ?? 0;
}

export async function getMaxRecoverySeq(db: D1Database, queueId: number): Promise<number> {
  const r = await db.prepare(
    `SELECT MAX(recovery_seq) as mx FROM call_queue_entries
     WHERE queue_id = ? AND queue_type = 'recovery'`
  ).bind(queueId).first<{ mx: number | null }>();
  return r?.mx ?? 0;
}

export async function getAbsentEntries(db: D1Database, queueId: number): Promise<CallQueueEntryRow[]> {
  const r = await db.prepare(
    `SELECT e.*, r.ticket_code FROM call_queue_entries e
     JOIN reservations r ON r.id = e.reservation_id
     WHERE e.queue_id = ? AND e.status = 'absent'
     ORDER BY e.queue_seq ASC`
  ).bind(queueId).all<CallQueueEntryRow>();
  return r.results;
}

// ============================================================
// users
// ============================================================
export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  const r = await db.prepare(
    'SELECT * FROM users WHERE username = ? AND status = ?'
  ).bind(username, 'active').first<UserRow>();
  return r ?? null;
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  const r = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  return r ?? null;
}

export async function getSheetPermission(
  db: D1Database, userId: number, sheetId: number
): Promise<UserSheetPermissionRow | null> {
  const r = await db.prepare(
    'SELECT * FROM user_sheet_permissions WHERE user_id = ? AND sheet_id = ?'
  ).bind(userId, sheetId).first<UserSheetPermissionRow>();
  return r ?? null;
}

export async function getProjectPermission(
  db: D1Database, userId: number, projectId: number
): Promise<UserProjectPermissionRow | null> {
  const r = await db.prepare(
    'SELECT * FROM user_project_permissions WHERE user_id = ? AND project_id = ?'
  ).bind(userId, projectId).first<UserProjectPermissionRow>();
  return r ?? null;
}

// ============================================================
// sheet_notices
// ============================================================
export async function getSheetNotices(
  db: D1Database, sheetId: number, screenType: string
): Promise<SheetNoticeRow[]> {
  const r = await db.prepare(
    `SELECT * FROM sheet_notices
     WHERE sheet_id = ? AND screen_type = ? AND status = 'active'
     ORDER BY sort_order`
  ).bind(sheetId, screenType).all<SheetNoticeRow>();
  return r.results;
}

// ============================================================
// audit_logs
// ============================================================
export async function insertAuditLog(
  db: D1Database,
  params: Omit<AuditLogRow, 'id' | 'created_at'>
): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_logs
     (actor_type, user_id, sheet_id, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    params.actor_type,
    params.user_id,
    params.sheet_id,
    params.action,
    params.target_type,
    params.target_id,
    params.details_json,
    now()
  ).run();
}
