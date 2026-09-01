import type { TimeSlotRow, TimeSlotStatus } from '../types';

// 画面設計 v0.5 §12 正規定義
export function calcTimeSlotStatus(
  slot: TimeSlotRow,
  queueHasCalling: boolean,
  now: Date
): TimeSlotStatus {
  const nowMs = now.getTime();
  const start      = new Date(slot.start_at).getTime();
  const end        = new Date(slot.end_at).getTime();
  const callStart  = new Date(slot.call_start_at).getTime();
  const callEnd    = new Date(slot.call_end_at).getTime();
  const expire     = new Date(slot.expire_at).getTime();

  if (nowMs >= expire) return 'expired';
  if (nowMs >= callEnd) return 'expiration_pending';
  if (nowMs >= callStart && nowMs < callEnd) {
    return queueHasCalling ? 'calling' : 'in_progress';
  }
  if (nowMs >= start && nowMs < callStart) return 'before_call';
  return 'reservation_open';
}

export function isReservationOpen(slot: TimeSlotRow, now: Date): boolean {
  // 予約受付は expiration_pending より前
  const nowMs  = now.getTime();
  const callEnd = new Date(slot.call_end_at).getTime();
  return nowMs < callEnd && slot.status === 'active';
}

export function isExpired(slot: TimeSlotRow, now: Date): boolean {
  return now.getTime() >= new Date(slot.expire_at).getTime();
}

export function canCall(slot: TimeSlotRow, now: Date): boolean {
  const nowMs   = now.getTime();
  const callEnd = new Date(slot.call_end_at).getTime();
  return nowMs < callEnd;
}

export function formatTicketCode(prefix: string, digits: number, num: number): string {
  return `${prefix}-${String(num).padStart(digits, '0')}`;
}
