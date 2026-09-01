import type { Env } from './types';
import { now } from './db/queries';
import { advanceQueue } from './domain/queue';
import { insertAuditLog } from './db/queries';

// ============================================================
// Cloudflare Cron Trigger（毎分実行）
// - 呼出開始（call_start_at 到達）
// - 通常呼出終了→expiration_pending 移行（call_end_at 到達）
// - 失効処理（expire_at 到達）
// ============================================================
export async function runScheduler(env: Env): Promise<void> {
  const db      = env.DB;
  const nowDate = new Date();
  const nowIso  = nowDate.toISOString();

  // ── 1. 呼出開始：call_start_at を迎えた waiting キュー ───────
  const toCallStart = await db.prepare(
    `SELECT q.id as queue_id, q.time_slot_id, t.sheet_id
     FROM call_queues q
     JOIN time_slots t ON t.id = q.time_slot_id
     WHERE q.status = 'waiting'
       AND t.call_start_at <= ?
       AND t.expire_at > ?`
  ).bind(nowIso, nowIso).all<{ queue_id: number; time_slot_id: number; sheet_id: number }>();

  for (const row of toCallStart.results) {
    // 通常キューに waiting エントリがあれば呼出開始
    const hasWaiting = await db.prepare(
      `SELECT COUNT(*) as cnt FROM call_queue_entries
       WHERE queue_id = ? AND queue_type = 'normal' AND status = 'waiting'`
    ).bind(row.queue_id).first<{ cnt: number }>();

    if ((hasWaiting?.cnt ?? 0) > 0) {
      await db.prepare(
        `UPDATE call_queues SET status='calling', updated_at=? WHERE id=? AND status='waiting'`
      ).bind(nowIso, row.queue_id).run();
      await advanceQueue(db, row.queue_id, 'system', null);
      await insertAuditLog(db, {
        actor_type: 'system', user_id: null, sheet_id: row.sheet_id,
        action: 'scheduler.call_start', target_type: 'queue', target_id: row.queue_id,
        details_json: null,
      });
    }
  }

  // ── 2. 呼出終了：call_end_at を迎えた calling キュー → expiration_pending ───
  const toExpPending = await db.prepare(
    `SELECT q.id as queue_id, q.time_slot_id, t.sheet_id, t.expire_at
     FROM call_queues q
     JOIN time_slots t ON t.id = q.time_slot_id
     WHERE q.status IN ('calling','waiting')
       AND t.call_end_at <= ?
       AND t.expire_at > ?`
  ).bind(nowIso, nowIso).all<{ queue_id: number; time_slot_id: number; sheet_id: number; expire_at: string }>();

  for (const row of toExpPending.results) {
    await db.prepare(
      `UPDATE call_queues SET status='expiration_pending', updated_at=? WHERE id=? AND status IN ('calling','waiting')`
    ).bind(nowIso, row.queue_id).run();
    await insertAuditLog(db, {
      actor_type: 'system', user_id: null, sheet_id: row.sheet_id,
      action: 'scheduler.expiration_pending', target_type: 'queue', target_id: row.queue_id,
      details_json: null,
    });
  }

  // ── 3. 失効処理：expire_at を迎えたキュー・予約 ───────────────
  const toExpire = await db.prepare(
    `SELECT q.id as queue_id, q.time_slot_id, t.sheet_id
     FROM call_queues q
     JOIN time_slots t ON t.id = q.time_slot_id
     WHERE q.status NOT IN ('finished','expired')
       AND t.expire_at <= ?`
  ).bind(nowIso).all<{ queue_id: number; time_slot_id: number; sheet_id: number }>();

  for (const row of toExpire.results) {
    // call_queue を expired に
    await db.prepare(
      `UPDATE call_queues SET status='expired', current_entry_id=NULL, updated_at=? WHERE id=?`
    ).bind(nowIso, row.queue_id).run();

    // call_queue_entries: waiting/calling/absent → expired
    await db.prepare(
      `UPDATE call_queue_entries SET status='expired', updated_at=?
       WHERE queue_id=? AND status IN ('waiting','calling','absent')`
    ).bind(nowIso, row.queue_id).run();

    // reservations: reserved/calling/absent → expired (accepted/entered は対象外)
    await db.prepare(
      `UPDATE reservations SET status='expired', updated_at=?
       WHERE time_slot_id=? AND status IN ('reserved','calling','absent')`
    ).bind(nowIso, row.time_slot_id).run();

    await insertAuditLog(db, {
      actor_type: 'system', user_id: null, sheet_id: row.sheet_id,
      action: 'scheduler.expire', target_type: 'queue', target_id: row.queue_id,
      details_json: null,
    });
  }
}
