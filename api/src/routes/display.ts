import { Hono } from 'hono';
import type { Env } from '../types';
import { getTimeSlotsBySheet, getCallQueueByTimeSlot, countReservations } from '../db/queries';
import { calcTimeSlotStatus } from '../domain/timeslot';
import { errorResponse, successResponse } from '../errors';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// GET /api/sheets/:sheetId/call-status
// 呼出モニター用（認証不要・公開）
// ============================================================
app.get('/sheets/:sheetId/call-status', async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const nowDate = new Date();

  // アクティブな時間帯を特定
  const slots = await getTimeSlotsBySheet(c.env.DB, sheetId);
  let activeSlot: any = null;
  let activeQueue: any = null;

  for (const slot of slots) {
    const queue = await getCallQueueByTimeSlot(c.env.DB, slot.id);
    const calling = queue?.status === 'calling' || queue?.status === 'recovery_calling';
    const st = calcTimeSlotStatus(slot, calling, nowDate);
    if (['calling','in_progress','expiration_pending','before_call'].includes(st)) {
      activeSlot  = slot;
      activeQueue = queue;
      break;
    }
  }

  if (!activeSlot || !activeQueue) {
    return successResponse({ current: null, next: [], next2: null, next3: null, absentList: [], timeSlot: null, queueStatus: null });
  }

  // 現在呼出中
  let current: any = null;
  if (activeQueue.current_entry_id) {
    const entry = await c.env.DB.prepare(
      `SELECT e.*, r.ticket_code, r.group_size FROM call_queue_entries e
       JOIN reservations r ON r.id = e.reservation_id WHERE e.id = ?`
    ).bind(activeQueue.current_entry_id).first<any>();
    if (entry) current = { ticketCode: entry.ticket_code, groupSize: entry.group_size, queueType: entry.queue_type };
  }

  // 次3件
  const nextRows = await c.env.DB.prepare(
    `SELECT r.ticket_code FROM call_queue_entries e
     JOIN reservations r ON r.id = e.reservation_id
     WHERE e.queue_id = ? AND e.queue_type = 'normal' AND e.status = 'waiting'
     ORDER BY e.queue_seq ASC LIMIT 3`
  ).bind(activeQueue.id).all<any>();
  const nextList = nextRows.results.map((r: any) => r.ticket_code);

  // 不在一覧
  const absentRows = await c.env.DB.prepare(
    `SELECT r.ticket_code FROM call_queue_entries e
     JOIN reservations r ON r.id = e.reservation_id
     WHERE e.queue_id = ? AND e.status = 'absent'
     ORDER BY e.queue_seq ASC`
  ).bind(activeQueue.id).all<any>();

  const slotStatus = calcTimeSlotStatus(activeSlot, !!current, nowDate);

  return successResponse({
    current,
    next:  nextList[0] ?? null,
    next2: nextList[1] ?? null,
    next3: nextList[2] ?? null,
    absentList: absentRows.results.map((r: any) => r.ticket_code),
    timeSlot: {
      id: activeSlot.id, name: activeSlot.name,
      startAt: activeSlot.start_at, endAt: activeSlot.end_at,
      callStartAt: activeSlot.call_start_at, callEndAt: activeSlot.call_end_at,
      expireAt: activeSlot.expire_at,
    },
    queueStatus: activeQueue.status,
    slotStatus,
    serverTime: nowDate.toISOString(),
  });
});

// ============================================================
// GET /api/sheets/:sheetId/status
// 受付状況モニター用（時間帯別統計）
// ============================================================
app.get('/sheets/:sheetId/status', async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const nowDate = new Date();
  const slots   = await getTimeSlotsBySheet(c.env.DB, sheetId);

  const timeSlots = await Promise.all(slots.map(async (slot) => {
    const queue   = await getCallQueueByTimeSlot(c.env.DB, slot.id);
    const calling = queue?.status === 'calling' || queue?.status === 'recovery_calling';
    const status  = calcTimeSlotStatus(slot, calling, nowDate);

    const counts = await c.env.DB.prepare(
      `SELECT status, COUNT(*) as cnt FROM reservations WHERE time_slot_id = ? GROUP BY status`
    ).bind(slot.id).all<{ status: string; cnt: number }>();
    const m: Record<string, number> = {};
    counts.results.forEach(r => { m[r.status] = r.cnt; });

    const reserved = Object.values(m).reduce((a, b) => a + b, 0) - (m['cancelled'] ?? 0) - (m['expired'] ?? 0);

    return {
      id: slot.id,
      name: slot.name,
      startAt: slot.start_at,
      endAt: slot.end_at,
      status,
      capacityGroups: slot.capacity_groups,
      reservedGroups: reserved,
      remainingGroups: Math.max(0, slot.capacity_groups - reserved),
      accepted: m['accepted'] ?? 0,
      absent:   m['absent']   ?? 0,
      expired:  m['expired']  ?? 0,
      isRecovery: queue?.status === 'recovery_calling',
    };
  }));

  return successResponse({ timeSlots, serverTime: nowDate.toISOString() });
});

export default app;
