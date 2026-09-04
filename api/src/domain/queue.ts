import type { Env, CallQueueRow, CallQueueEntryRow, ReservationRow } from '../types';
import {
  getCallQueue, getCallQueueByTimeSlot, getEntry,
  getNextNormalEntry, getNextRecoveryEntry,
  hasNormalWaiting, getMaxQueueSeq, getMaxRecoverySeq,
  insertAuditLog, now,
} from '../db/queries';

// ============================================================
// 次の呼出を進める（受付完了後・不在次へ後 共通）
// API設計 v1.4 §8.2 自動再呼出ロジック
// ============================================================
export async function advanceQueue(
  db: D1Database,
  queueId: number,
  actorType: string,
  userId: number | null
): Promise<void> {
  const queue = await getCallQueue(db, queueId);
  if (!queue) return;

  // ==========================================================
  // 通常キューの次の1件を直接取得
  // ==========================================================
  const entry = await getNextNormalEntry(db, queueId);

  if (entry) {
    const timestamp = now();

    await db.batch([
      db.prepare(
        `UPDATE call_queue_entries
         SET
           status = 'calling',
           called_at = ?,
           updated_at = ?
         WHERE id = ?`
      ).bind(
        timestamp,
        timestamp,
        entry.id
      ),

      db.prepare(
        `UPDATE reservations
         SET
           status = 'calling',
           updated_at = ?
         WHERE id = ?`
      ).bind(
        timestamp,
        entry.reservation_id
      ),

      db.prepare(
        `UPDATE call_queues
         SET
           status = 'calling',
           current_entry_id = ?,
           updated_at = ?
         WHERE id = ?`
      ).bind(
        entry.id,
        timestamp,
        queueId
      ),
    ]);

    await insertAuditLog(db, {
      actor_type: actorType,
      user_id: userId,
      sheet_id: null,
      action: 'queue.advance_normal',
      target_type: 'entry',
      target_id: entry.id,
      details_json: JSON.stringify({
        queueId,
        reservationId: entry.reservation_id,
      }),
    });

    return;
  }

  // ==========================================================
  // 通常キューに待機がなければ救済キュー
  // ==========================================================
  const recoveryEntry =
    await getNextRecoveryEntry(
      db,
      queueId
    );

  if (recoveryEntry) {
    const timestamp = now();

    await db.batch([
      db.prepare(
        `UPDATE call_queue_entries
         SET
           status = 'calling',
           called_at = ?,
           updated_at = ?
         WHERE id = ?`
      ).bind(
        timestamp,
        timestamp,
        recoveryEntry.id
      ),

      db.prepare(
        `UPDATE reservations
         SET
           status = 'calling',
           updated_at = ?
         WHERE id = ?`
      ).bind(
        timestamp,
        timestamp,
        recoveryEntry.reservation_id
      ),

      db.prepare(
        `UPDATE call_queues
         SET
           status = 'recovery_calling',
           current_entry_id = ?,
           updated_at = ?
         WHERE id = ?`
      ).bind(
        recoveryEntry.id,
        timestamp,
        queueId
      ),
    ]);

    await insertAuditLog(db, {
      actor_type: actorType,
      user_id: userId,
      sheet_id: null,
      action: 'queue.advance_recovery',
      target_type: 'entry',
      target_id: recoveryEntry.id,
      details_json: JSON.stringify({
        queueId,
        reservationId:
          recoveryEntry.reservation_id,
      }),
    });

    return;
  }

  // ==========================================================
  // 何も待機していなければ終了
  // ==========================================================
  await db.prepare(
    `UPDATE call_queues
     SET
       status = 'finished',
       current_entry_id = NULL,
       updated_at = ?
     WHERE id = ?`
  ).bind(
    now(),
    queueId
  ).run();
}

// ============================================================
// 不在にして次へ
// ============================================================
export async function markAbsentAndNext(
  db: D1Database,
  queueId: number,
  currentEntryId: number,
  actorType: string,
  userId: number | null,
  sheetId: number | null
): Promise<void> {
  const entry = await getEntry(db, currentEntryId);
  if (!entry) throw new Error('entry not found');

  // 通常キューの最後尾 seq
  const maxSeq = await getMaxQueueSeq(db, queueId);

  await db.batch([
    db.prepare(
      `UPDATE call_queue_entries
       SET status='absent', queue_seq=?, updated_at=? WHERE id=?`
    ).bind(maxSeq + 1, now(), currentEntryId),
    db.prepare(
      `UPDATE reservations SET status='absent', updated_at=? WHERE id=?`
    ).bind(now(), entry.reservation_id),
    db.prepare(
      `UPDATE call_queues SET current_entry_id=NULL, updated_at=? WHERE id=?`
    ).bind(now(), queueId),
  ]);

  await insertAuditLog(db, {
    actor_type: actorType, user_id: userId, sheet_id: sheetId,
    action: 'reservation.mark_absent', target_type: 'reservation', target_id: entry.reservation_id,
    details_json: null,
  });

  // 次を呼ぶ
  await advanceQueue(db, queueId, actorType, userId);
}

// ============================================================
// 受付完了処理（呼出キュー側の更新）
// ============================================================
export async function completeEntry(
  db: D1Database,
  entryId: number,
  queueId: number,
  reservationId: number,
  actorType: string,
  userId: number | null,
  sheetId: number | null
): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE call_queue_entries
       SET status='completed', completed_at=?, updated_at=? WHERE id=?`
    ).bind(now(), now(), entryId),
    db.prepare(
      `UPDATE reservations SET status='accepted', updated_at=? WHERE id=?`
    ).bind(now(), reservationId),
    db.prepare(
      `UPDATE call_queues SET current_entry_id=NULL, updated_at=? WHERE id=?`
    ).bind(now(), queueId),
  ]);

  await insertAuditLog(db, {
    actor_type: actorType, user_id: userId, sheet_id: sheetId,
    action: 'reservation.accept', target_type: 'reservation', target_id: reservationId,
    details_json: null,
  });

  // 受付成功後も自動で次を呼ぶ
  await advanceQueue(db, queueId, actorType, userId);
}
