import { Hono } from 'hono';
import type { Env } from '../types';
import {
  getSheet, getTimeSlotsBySheet, getCallQueueByTimeSlot,
  getCallingEntry, getNextNormalEntry, getAbsentEntries,
  getReservation, getReservationByCode, getEntry,
  getMaxQueueSeq, getMaxRecoverySeq, hasNormalWaiting,
  countReservations, insertAuditLog, now,
} from '../db/queries';
import { calcTimeSlotStatus, isExpired, canCall } from '../domain/timeslot';
import { advanceQueue, markAbsentAndNext, completeEntry } from '../domain/queue';
import { requireAuth, requireSheetPermission } from '../middleware';
import { errorResponse, successResponse } from '../errors';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// GET /api/staff/sheets/:sheetId/overview
// スタッフ画面初期表示・ポーリング共用
// ============================================================
app.get('/sheets/:sheetId/overview', requireAuth, requireSheetPermission('staff'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const sheet   = await getSheet(c.env.DB, sheetId);
  if (!sheet)   return errorResponse('SHEET_NOT_FOUND', 'シートが見つかりません');

  const nowDate = new Date();
  const slots   = await getTimeSlotsBySheet(c.env.DB, sheetId);

  // 現在アクティブな時間帯を特定（呼出中 or 進行中を優先）
  let activeSlot: any = null;
  const slotSummaries = await Promise.all(slots.map(async (slot) => {
    const queue        = await getCallQueueByTimeSlot(c.env.DB, slot.id);
    const queueCalling = queue?.status === 'calling' || queue?.status === 'recovery_calling';
    const slotStatus   = calcTimeSlotStatus(slot, queueCalling, nowDate);
    const reserved     = await countReservations(c.env.DB, slot.id);

    // 受付済み・不在・失効カウント
    const counts = await c.env.DB.prepare(
      `SELECT status, COUNT(*) as cnt FROM reservations
       WHERE time_slot_id = ? GROUP BY status`
    ).bind(slot.id).all<{ status: string; cnt: number }>();
    const countMap: Record<string, number> = {};
    counts.results.forEach(r => { countMap[r.status] = r.cnt; });

    const summary = {
      id: slot.id,
      name: slot.name,
      startAt: slot.start_at,
      endAt: slot.end_at,
      expireAt: slot.expire_at,
      status: slotStatus,
      capacityGroups: slot.capacity_groups,
      reservedGroups: reserved,
      remainingGroups: Math.max(0, slot.capacity_groups - reserved),
      accepted: countMap['accepted'] ?? 0,
      absent: countMap['absent'] ?? 0,
      expired: countMap['expired'] ?? 0,
      queue: queue ? { id: queue.id, status: queue.status, currentEntryId: queue.current_entry_id } : null,
    };

    if (
  !activeSlot &&
  (
    ['calling', 'in_progress', 'expiration_pending', 'before_call'].includes(slotStatus)
    || queue?.status === 'waiting'
  )
) {
  activeSlot = { slot, queue, slotStatus };
}
    return summary;
  }));

  // 現在呼出中・次候補を取得
  let current: any = null;
  let nextEntries: any[] = [];
  let absentList: any[] = [];
  let recoveryQueue: any[] = [];
  let canAccept = false;
  let canNext   = false;

  if (activeSlot?.queue) {
    const q = activeSlot.queue;

    if (q.current_entry_id) {
      const entry = await getEntry(c.env.DB, q.current_entry_id);
      if (entry) {
        const res = await getReservation(c.env.DB, entry.reservation_id);
        current = { entryId: entry.id, reservationId: res?.id, ticketCode: res?.ticket_code, groupSize: res?.group_size, queueType: entry.queue_type };
        canAccept = !!res && !isExpired(activeSlot.slot, nowDate);
      }
    }

    // 次3件（通常キュー）
    const nextRows = await c.env.DB.prepare(
      `SELECT e.*, r.ticket_code, r.group_size FROM call_queue_entries e
       JOIN reservations r ON r.id = e.reservation_id
       WHERE e.queue_id = ? AND e.queue_type = 'normal' AND e.status = 'waiting'
       ORDER BY e.queue_seq ASC LIMIT 3`
    ).bind(q.id).all<any>();
    nextEntries = nextRows.results.map(r => ({ ticketCode: r.ticket_code, groupSize: r.group_size }));

    // 不在一覧
    const absentRows = await c.env.DB.prepare(
      `SELECT e.*, r.ticket_code FROM call_queue_entries e
       JOIN reservations r ON r.id = e.reservation_id
       WHERE e.queue_id = ? AND e.status = 'absent'
       ORDER BY e.queue_seq ASC`
    ).bind(q.id).all<any>();
    absentList = absentRows.results.map(r => ({ ticketCode: r.ticket_code, entryId: r.id }));

    // 救済キュー
    const recoveryRows = await c.env.DB.prepare(
      `SELECT e.*, r.ticket_code FROM call_queue_entries e
       JOIN reservations r ON r.id = e.reservation_id
       WHERE e.queue_id = ? AND e.queue_type = 'recovery' AND e.status IN ('waiting','calling')
       ORDER BY e.recovery_seq ASC`
    ).bind(q.id).all<any>();
    recoveryQueue = recoveryRows.results.map(r => ({ ticketCode: r.ticket_code, status: r.status }));

    canNext = !q.current_entry_id && canCall(activeSlot.slot, nowDate) && await hasNormalWaiting(c.env.DB, q.id);
  }

  return successResponse({
    sheet: { id: sheet.id, name: sheet.name },
    activeTimeSlot: activeSlot ? {
      id: activeSlot.slot.id,
      name: activeSlot.slot.name,
      status: activeSlot.slotStatus,
    } : null,
    current,
    next: nextEntries,
    absent: absentList,
    recoveryQueue,
    canAccept,
    canNext,
    timeSlots: slotSummaries,
    serverTime: nowDate.toISOString(),
  });
});

// ============================================================
// GET /api/staff/reservations/:reservationId/confirm
// 受付確認画面用
// ============================================================
app.get('/reservations/:reservationId/confirm', requireAuth, async (c) => {
  const reservationId = parseInt(c.req.param('reservationId'), 10);
  const reservation   = await getReservation(c.env.DB, reservationId);
  if (!reservation) return errorResponse('RESERVATION_NOT_FOUND', '予約が見つかりません');

  const slot = await c.env.DB.prepare(
    'SELECT * FROM time_slots WHERE id = ?'
  ).bind(reservation.time_slot_id).first<any>();

  const nowDate  = new Date();
  const expired  = isExpired(slot, nowDate);
  const canAccept = reservation.status === 'calling' && !expired;

  return successResponse({
    reservation: {
      id: reservation.id,
      ticketCode: reservation.ticket_code,
      groupSize: reservation.group_size,
      status: reservation.status,
    },
    timeSlot: { name: slot?.name, startAt: slot?.start_at, endAt: slot?.end_at },
    canAccept,
    expireAt: slot?.expire_at,
  });
});

// ============================================================
// POST /api/staff/reservations/:reservationId/accept
// 受付処理
// ============================================================
app.post('/reservations/:reservationId/accept', requireAuth, async (c) => {
  const reservationId = parseInt(c.req.param('reservationId'), 10);
  const session = c.get('session');

  const reservation = await getReservation(c.env.DB, reservationId);
  if (!reservation) return errorResponse('RESERVATION_NOT_FOUND', '予約が見つかりません');

  if (reservation.status !== 'calling') {
    if (reservation.status === 'accepted') return errorResponse('ALREADY_ACCEPTED', '既に受付済みです');
    return errorResponse('INVALID_STATE', '呼出中でないため受付できません');
  }

  const slot = await c.env.DB.prepare(
    'SELECT * FROM time_slots WHERE id = ?'
  ).bind(reservation.time_slot_id).first<any>();

  const nowDate = new Date();
  if (isExpired(slot, nowDate)) return errorResponse('EXPIRED', '失効時刻を過ぎているため受付できません');

  // 対応するキューEntryを取得
  const entry = await c.env.DB.prepare(
    `SELECT * FROM call_queue_entries WHERE reservation_id = ? AND status = 'calling' LIMIT 1`
  ).bind(reservationId).first<any>();
  if (!entry) return errorResponse('INVALID_STATE', 'キューエントリが見つかりません');

  const queue = await c.env.DB.prepare('SELECT * FROM call_queues WHERE id = ?').bind(entry.queue_id).first<any>();
  if (!queue) return errorResponse('QUEUE_NOT_FOUND', 'キューが見つかりません');

  await completeEntry(
    c.env.DB, entry.id, queue.id, reservationId,
    'staff', session?.userId ?? null, reservation.sheet_id
  );

  return successResponse({ ticketCode: reservation.ticket_code, status: 'accepted' });
});

// ============================================================
// POST /api/staff/queues/:queueId/mark-absent-and-next
// 不在にして次へ
// ============================================================
app.post('/queues/:queueId/mark-absent-and-next', requireAuth, async (c) => {
  const queueId = parseInt(c.req.param('queueId'), 10);
  const session = c.get('session');

  const queue = await c.env.DB.prepare('SELECT * FROM call_queues WHERE id = ?').bind(queueId).first<any>();
  if (!queue) return errorResponse('QUEUE_NOT_FOUND', 'キューが見つかりません');

  const slot = await c.env.DB.prepare(
    'SELECT * FROM time_slots WHERE id = ?'
  ).bind(queue.time_slot_id).first<any>();

  if (!canCall(slot, new Date())) {
    return errorResponse('QUEUE_CALL_CLOSED', '呼出終了時刻を過ぎています');
  }
  if (!queue.current_entry_id) {
    return errorResponse('INVALID_STATE', '現在呼出中の番号がありません');
  }

  const sheetId = slot?.sheet_id ?? null;
  await markAbsentAndNext(c.env.DB, queueId, queue.current_entry_id, 'staff', session?.userId ?? null, sheetId);

  return successResponse({ message: '不在処理し次を呼び出しました' });
});

// ============================================================
// POST /api/staff/queues/:queueId/call-next
// 次へ（呼出中なしの場合の手動開始）
// ============================================================
app.post('/queues/:queueId/call-next', requireAuth, async (c) => {
  const queueId = parseInt(c.req.param('queueId'), 10);
  const session = c.get('session');

  const queue = await c.env.DB.prepare('SELECT * FROM call_queues WHERE id = ?').bind(queueId).first<any>();
  if (!queue) return errorResponse('QUEUE_NOT_FOUND', 'キューが見つかりません');
  if (queue.current_entry_id) return errorResponse('CURRENT_CALLING_EXISTS', '既に呼出中の番号があります');

  const slot = await c.env.DB.prepare('SELECT * FROM time_slots WHERE id = ?').bind(queue.time_slot_id).first<any>();
  if (!canCall(slot, new Date())) return errorResponse('QUEUE_NORMAL_CALLING_CLOSED', '通常呼出終了時刻を過ぎています');

  await advanceQueue(c.env.DB, queueId, 'staff', session?.userId ?? null);

  return successResponse({ message: '次を呼び出しました' });
});

// ============================================================
// POST /api/staff/queues/:queueId/recovery
// 救済キュー追加
// ============================================================
app.post('/queues/:queueId/recovery', requireAuth, async (c) => {
  const queueId = parseInt(c.req.param('queueId'), 10);
  const body    = await c.req.json<{ reservationId: number }>();
  const session = c.get('session');

  const queue = await c.env.DB.prepare('SELECT * FROM call_queues WHERE id = ?').bind(queueId).first<any>();
  if (!queue) return errorResponse('QUEUE_NOT_FOUND', 'キューが見つかりません');
  if (!['expiration_pending','recovery_calling'].includes(queue.status)) {
    return errorResponse('RECOVERY_NOT_ALLOWED', '失効待ち状態でないため救済キュー追加できません');
  }

  const slot = await c.env.DB.prepare('SELECT * FROM time_slots WHERE id = ?').bind(queue.time_slot_id).first<any>();
  const nowDate = new Date();
  if (isExpired(slot, nowDate)) return errorResponse('EXPIRED', '失効時刻を過ぎています');

  const reservation = await getReservation(c.env.DB, body.reservationId);
  if (!reservation) return errorResponse('RESERVATION_NOT_FOUND', '予約が見つかりません');
  if (reservation.time_slot_id !== queue.time_slot_id) {
    return errorResponse('INVALID_STATE', '対象外の時間帯の予約です');
  }

  // 既に救済キューにいないか確認
  const existing = await c.env.DB.prepare(
    `SELECT id FROM call_queue_entries
     WHERE queue_id = ? AND reservation_id = ? AND queue_type = 'recovery' AND status != 'cancelled'`
  ).bind(queueId, body.reservationId).first();
  if (existing) return errorResponse('INVALID_STATE', '既に救済キューに追加済みです');

  const maxRecovery = await getMaxRecoverySeq(c.env.DB, queueId);
  const nextRecoverySeq = maxRecovery + 1;

  await c.env.DB.prepare(
    `INSERT INTO call_queue_entries
     (queue_id, reservation_id, queue_type, recovery_seq, status, updated_at)
     VALUES (?, ?, 'recovery', ?, 'waiting', ?)`
  ).bind(queueId, body.reservationId, nextRecoverySeq, now()).run();

  await insertAuditLog(c.env.DB, {
    actor_type: 'staff', user_id: session?.userId ?? null, sheet_id: slot?.sheet_id ?? null,
    action: 'queue.recovery_add', target_type: 'reservation', target_id: body.reservationId,
    details_json: JSON.stringify({ recoverySeq: nextRecoverySeq }),
  });

  // 呼出中がなければすぐに救済呼出を開始
  if (!queue.current_entry_id) {
    await advanceQueue(c.env.DB, queueId, 'staff', session?.userId ?? null);
  }

  return successResponse({ message: '救済キューに追加しました', recoverySeq: nextRecoverySeq });
});

// ============================================================
// GET /api/staff/sheets/:sheetId/reservations/search
// 整理番号検索
// ============================================================
app.get('/sheets/:sheetId/reservations/search', requireAuth, requireSheetPermission('staff'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const q       = c.req.query('q') ?? '';
  if (!q) return errorResponse('VALIDATION_ERROR', '検索クエリは必須です');

  const rows = await c.env.DB.prepare(
    `SELECT r.*, t.name as slot_name, t.start_at, t.end_at, t.expire_at
     FROM reservations r
     JOIN time_slots t ON t.id = r.time_slot_id
     WHERE r.sheet_id = ? AND r.ticket_code LIKE ?
     LIMIT 10`
  ).bind(sheetId, `%${q}%`).all<any>();

  return successResponse({ results: rows.results.map(r => ({
    id: r.id,
    ticketCode: r.ticket_code,
    groupSize: r.group_size,
    status: r.status,
    timeSlot: { name: r.slot_name, startAt: r.start_at, endAt: r.end_at },
    expireAt: r.expire_at,
  }))});
});

// ============================================================
// POST /api/staff/reservations/:reservationId/emergency-call
// 即時呼出
// ============================================================
app.post('/reservations/:reservationId/emergency-call', requireAuth, async (c) => {
  const reservationId = parseInt(c.req.param('reservationId'), 10);
  const session = c.get('session');

  const reservation = await getReservation(c.env.DB, reservationId);
  if (!reservation) return errorResponse('RESERVATION_NOT_FOUND', '予約が見つかりません');

  const slot = await c.env.DB.prepare('SELECT * FROM time_slots WHERE id = ?').bind(reservation.time_slot_id).first<any>();
  const nowDate = new Date();
  if (isExpired(slot, nowDate)) return errorResponse('EXPIRED', '失効時刻を過ぎています');

  const queue = await getCallQueueByTimeSlot(c.env.DB, reservation.time_slot_id);
  if (!queue) return errorResponse('QUEUE_NOT_FOUND', 'キューが見つかりません');
  if (queue.current_entry_id) return errorResponse('CURRENT_CALLING_EXISTS', '既に呼出中の番号があります');
  if (['expiration_pending','recovery_calling'].includes(queue.status)) {
    return errorResponse('EMERGENCY_CALL_NOT_ALLOWED', '失効待ち中は通常即時呼出できません。救済キューを使用してください');
  }

  const entry = await c.env.DB.prepare(
    `SELECT * FROM call_queue_entries WHERE queue_id = ? AND reservation_id = ? AND status = 'waiting' LIMIT 1`
  ).bind(queue.id, reservationId).first<any>();
  if (!entry) return errorResponse('INVALID_STATE', 'キューエントリが見つかりません');

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE call_queue_entries SET status='calling', called_at=?, updated_at=? WHERE id=?`).bind(now(), now(), entry.id),
    c.env.DB.prepare(`UPDATE reservations SET status='calling', updated_at=? WHERE id=?`).bind(now(), reservationId),
    c.env.DB.prepare(`UPDATE call_queues SET status='calling', current_entry_id=?, updated_at=? WHERE id=?`).bind(entry.id, now(), queue.id),
  ]);

  await insertAuditLog(c.env.DB, {
    actor_type: 'staff', user_id: session?.userId ?? null, sheet_id: reservation.sheet_id,
    action: 'reservation.emergency_call', target_type: 'reservation', target_id: reservationId,
    details_json: JSON.stringify({ ticketCode: reservation.ticket_code }),
  });

  return successResponse({ ticketCode: reservation.ticket_code, status: 'calling' });
});

// ============================================================
// POST /api/staff/reservations/:reservationId/cancel
// 即時キャンセル
// ============================================================
app.post('/reservations/:reservationId/cancel', requireAuth, async (c) => {
  const reservationId = parseInt(c.req.param('reservationId'), 10);
  const session = c.get('session');

  const reservation = await getReservation(c.env.DB, reservationId);
  if (!reservation) return errorResponse('RESERVATION_NOT_FOUND', '予約が見つかりません');
  if (['cancelled','expired','entered'].includes(reservation.status)) {
    return errorResponse('INVALID_STATE', 'キャンセルできない状態です');
  }

  const cancelledAt = now();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE reservations SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=?`).bind(cancelledAt, cancelledAt, reservationId),
    c.env.DB.prepare(`UPDATE call_queue_entries SET status='cancelled', updated_at=? WHERE reservation_id=? AND status IN ('waiting','calling')`).bind(cancelledAt, reservationId),
  ]);

  // もし呼出中だったキューの current_entry_id をクリア
  await c.env.DB.prepare(
    `UPDATE call_queues SET current_entry_id=NULL, updated_at=? WHERE current_entry_id IN
     (SELECT id FROM call_queue_entries WHERE reservation_id=?)`
  ).bind(cancelledAt, reservationId).run();

  await insertAuditLog(c.env.DB, {
    actor_type: 'staff', user_id: session?.userId ?? null, sheet_id: reservation.sheet_id,
    action: 'reservation.emergency_cancel', target_type: 'reservation', target_id: reservationId,
    details_json: null,
  });

  return successResponse({ message: 'キャンセルしました' });
});

export default app;
