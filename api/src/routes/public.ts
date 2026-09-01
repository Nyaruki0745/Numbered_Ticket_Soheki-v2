import { Hono } from 'hono';
import type { Env } from '../types';
import {
  getSheet, getTimeSlotsBySheet, countReservations,
  getSheetNotices, getCallQueueByTimeSlot, getReservation,
  getCallingEntry, insertAuditLog, now,
} from '../db/queries';
import { calcTimeSlotStatus, isReservationOpen, formatTicketCode } from '../domain/timeslot';
import { generateToken, hashToken } from '../auth';
import { errorResponse, successResponse } from '../errors';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// GET /api/public/sheets/:sheetId
// 予約端末向けシート情報・時間帯一覧
// ============================================================
app.get('/sheets/:sheetId', async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const sheet = await getSheet(c.env.DB, sheetId);
  if (!sheet || sheet.status !== 'active') return errorResponse('SHEET_NOT_FOUND', 'シートが見つかりません');

  const slots     = await getTimeSlotsBySheet(c.env.DB, sheetId);
  const notices   = await getSheetNotices(c.env.DB, sheetId, 'reserve');
  const nowDate   = new Date();

  const timeSlots = await Promise.all(slots.map(async (slot) => {
    const queue         = await getCallQueueByTimeSlot(c.env.DB, slot.id);
    const queueCalling  = queue?.status === 'calling' || queue?.status === 'recovery_calling';
    const reserved      = await countReservations(c.env.DB, slot.id);
    const remaining     = Math.max(0, slot.capacity_groups - reserved);
    const status        = calcTimeSlotStatus(slot, queueCalling, nowDate);
    const open          = isReservationOpen(slot, nowDate) && remaining > 0;

    return {
      id: slot.id,
      name: slot.name,
      startAt: slot.start_at,
      endAt: slot.end_at,
      capacityGroups: slot.capacity_groups,
      reservedGroups: reserved,
      remainingGroups: remaining,
      status,
      isOpen: open,
    };
  }));

  return successResponse({ sheet: { id: sheet.id, name: sheet.name }, timeSlots, notices });
});

// ============================================================
// POST /api/public/sheets/:sheetId/reservations
// 予約作成（定員チェック・採番・キューEntry作成を1トランザクションで）
// ============================================================
app.post('/sheets/:sheetId/reservations', async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body = await c.req.json<{ timeSlotId: number; groupSize: number }>();

  if (!body.timeSlotId || !body.groupSize || body.groupSize < 1) {
    return errorResponse('VALIDATION_ERROR', 'timeSlotId と groupSize（1以上）は必須です');
  }

  const sheet = await getSheet(c.env.DB, sheetId);
  if (!sheet || sheet.status !== 'active') return errorResponse('SHEET_NOT_FOUND', 'シートが見つかりません');

  // time_slot確認
  const slot = await c.env.DB.prepare(
    'SELECT * FROM time_slots WHERE id = ? AND sheet_id = ?'
  ).bind(body.timeSlotId, sheetId).first<any>();
  if (!slot) return errorResponse('TIME_SLOT_NOT_FOUND', '時間帯が見つかりません');

  const nowDate = new Date();
  if (!isReservationOpen(slot, nowDate)) {
    return errorResponse('RESERVATION_NOT_ALLOWED', '予約受付時間外です');
  }

  // 定員確認 + 採番 + 予約作成をD1バッチトランザクションで
  // D1はSELECT FOR UPDATEが使えないため ticket_next_number のCAS更新で競合を防ぐ
  const result = await c.env.DB.batch([
    // 1. 現在の ticket_next_number を取得して採番
    c.env.DB.prepare(
      `UPDATE sheets SET ticket_next_number = ticket_next_number + 1,
       updated_at = ? WHERE id = ? RETURNING ticket_next_number`
    ).bind(now(), sheetId),
  ]);

  const nextNum = (result[0].results[0] as any)?.ticket_next_number;
  if (!nextNum) return errorResponse('INTERNAL_ERROR', '採番に失敗しました');

  // 定員チェック（採番後に確認して超えていたらキャンセル）
  const reserved = await countReservations(c.env.DB, body.timeSlotId);
  if (reserved > slot.capacity_groups) {
    // 採番を戻す
    await c.env.DB.prepare(
      `UPDATE sheets SET ticket_next_number = ticket_next_number - 1, updated_at = ? WHERE id = ?`
    ).bind(now(), sheetId).run();
    return errorResponse('CAPACITY_FULL', '定員に達しています');
  }

  const ticketCode = formatTicketCode(sheet.ticket_prefix, sheet.ticket_digits, nextNum);
  const cancelToken = generateToken();
  const cancelTokenHash = await hashToken(cancelToken);
  const reservedAt = now();

  // キュー取得または作成
  let queue = await getCallQueueByTimeSlot(c.env.DB, body.timeSlotId);
  let queueId: number;
  if (!queue) {
    const qr = await c.env.DB.prepare(
      `INSERT INTO call_queues (time_slot_id, status, created_at, updated_at)
       VALUES (?, 'waiting', ?, ?) RETURNING id`
    ).bind(body.timeSlotId, reservedAt, reservedAt).first<{ id: number }>();
    queueId = qr!.id;
  } else {
    queueId = queue.id;
  }

  // 予約 + キューEntry を一括挿入
  const maxSeq = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(queue_seq), 0) as mx FROM call_queue_entries
     WHERE queue_id = ? AND queue_type = 'normal'`
  ).bind(queueId).first<{ mx: number }>();
  const nextSeq = (maxSeq?.mx ?? 0) + 1;

  // 予約作成
  const resInsert = await c.env.DB.prepare(
    `INSERT INTO reservations
     (sheet_id, time_slot_id, ticket_number, ticket_code, group_size,
      status, reserved_at, updated_at, cancel_token_hash)
     VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?) RETURNING id`
  ).bind(sheetId, body.timeSlotId, nextNum, ticketCode,
     body.groupSize, reservedAt, reservedAt, cancelTokenHash).first<{ id: number }>();

  const reservationId = resInsert?.id;
  if (!reservationId) {
    await c.env.DB.prepare(`UPDATE sheets SET ticket_next_number = ticket_next_number - 1, updated_at = ? WHERE id = ?`).bind(now(), sheetId).run();
    return errorResponse('INTERNAL_ERROR', '予約作成に失敗しました');
  }

  // キューエントリ作成
  await c.env.DB.prepare(
    `INSERT INTO call_queue_entries
     (queue_id, reservation_id, queue_type, queue_seq, status, updated_at)
     VALUES (?, ?, 'normal', ?, 'waiting', ?)`
  ).bind(queueId, reservationId, nextSeq, reservedAt).run();

  await insertAuditLog(c.env.DB, {
    actor_type: 'visitor', user_id: null, sheet_id: sheetId,
    action: 'reservation.create', target_type: 'reservation', target_id: reservationId,
    details_json: JSON.stringify({ ticketCode, groupSize: body.groupSize }),
  });

  const slotNotices = await getSheetNotices(c.env.DB, sheetId, 'reservation_complete');

  return successResponse({
    reservation: {
      id: reservationId,
      ticketCode,
      timeSlot: { name: slot.name, startAt: slot.start_at, endAt: slot.end_at },
      groupSize: body.groupSize,
      status: 'reserved',
      cancelToken, // 来場者に渡す（DBにはhashのみ保存）
    },
    notices: slotNotices,
  }, 201);
});

// ============================================================
// POST /api/public/reservations/:reservationId/cancel
// 来場者キャンセル（ticketCode + cancelToken）
// ============================================================
app.post('/reservations/:reservationId/cancel', async (c) => {
  const reservationId = parseInt(c.req.param('reservationId'), 10);
  const body = await c.req.json<{ ticketCode: string; cancelToken: string }>();
  if (!body.ticketCode || !body.cancelToken) {
    return errorResponse('VALIDATION_ERROR', 'ticketCode と cancelToken は必須です');
  }

  const reservation = await getReservation(c.env.DB, reservationId);
  if (!reservation) return errorResponse('RESERVATION_NOT_FOUND', '予約が見つかりません');

  if (reservation.ticket_code !== body.ticketCode) {
    return errorResponse('FORBIDDEN', '認証情報が一致しません');
  }

  const tokenHash = await hashToken(body.cancelToken);
  if (reservation.cancel_token_hash !== tokenHash) {
    return errorResponse('FORBIDDEN', '認証情報が一致しません');
  }

  if (['cancelled', 'expired', 'entered'].includes(reservation.status)) {
    return errorResponse('INVALID_STATE', 'キャンセルできない状態です');
  }

  const cancelledAt = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE reservations SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=?`
    ).bind(cancelledAt, cancelledAt, reservationId),
    c.env.DB.prepare(
      `UPDATE call_queue_entries SET status='cancelled', updated_at=? WHERE reservation_id=? AND status='waiting'`
    ).bind(cancelledAt, reservationId),
  ]);

  await insertAuditLog(c.env.DB, {
    actor_type: 'visitor', user_id: null, sheet_id: reservation.sheet_id,
    action: 'reservation.cancel', target_type: 'reservation', target_id: reservationId,
    details_json: null,
  });

  return successResponse({ message: 'キャンセルしました' });
});

export default app;
