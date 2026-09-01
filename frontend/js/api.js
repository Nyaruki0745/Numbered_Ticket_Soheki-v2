// API クライアント共通
export const API_BASE = "https://seiriken-api.soheki-numberedticket.workers.dev" ?? '';

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('seiriken_token');
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...options.headers,
    },
    ...options,
  });
  const json = await res.json();
  if (!json.ok) throw Object.assign(new Error(json.error?.message ?? 'APIエラー'), { code: json.error?.code });
  return json.data;
}

export const api = {
  // 認証
  login: (username, password) => apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),

  // 公開
  getSheet: (sheetId) => apiFetch(`/public/sheets/${sheetId}`),
  createReservation: (sheetId, body, idempotencyKey) =>
    apiFetch(`/public/sheets/${sheetId}/reservations`, { method: 'POST', body: JSON.stringify(body), idempotencyKey }),
  cancelReservation: (id, body) =>
    apiFetch(`/public/reservations/${id}/cancel`, { method: 'POST', body: JSON.stringify(body) }),

  // スタッフ
  getOverview: (sheetId) => apiFetch(`/staff/sheets/${sheetId}/overview`),
  confirmReservation: (id) => apiFetch(`/staff/reservations/${id}/confirm`),
  acceptReservation: (id, key) => apiFetch(`/staff/reservations/${id}/accept`, { method: 'POST', body: '{}', idempotencyKey: key }),
  markAbsentAndNext: (queueId, key) => apiFetch(`/staff/queues/${queueId}/mark-absent-and-next`, { method: 'POST', body: '{}', idempotencyKey: key }),
  callNext: (queueId, key) => apiFetch(`/staff/queues/${queueId}/call-next`, { method: 'POST', body: '{}', idempotencyKey: key }),
  addRecovery: (queueId, reservationId, key) =>
    apiFetch(`/staff/queues/${queueId}/recovery`, { method: 'POST', body: JSON.stringify({ reservationId }), idempotencyKey: key }),
  searchReservations: (sheetId, q) => apiFetch(`/staff/sheets/${sheetId}/reservations/search?q=${encodeURIComponent(q)}`),
  emergencyCall: (id, key) => apiFetch(`/staff/reservations/${id}/emergency-call`, { method: 'POST', body: '{}', idempotencyKey: key }),
  cancelStaff: (id, key) => apiFetch(`/staff/reservations/${id}/cancel`, { method: 'POST', body: '{}', idempotencyKey: key }),

  // モニター
  getCallStatus: (sheetId) => apiFetch(`/sheets/${sheetId}/call-status`),
  getStatus: (sheetId) => apiFetch(`/sheets/${sheetId}/status`),

  // 管理
  createTimeSlot: (sheetId, body) => apiFetch(`/manage/sheets/${sheetId}/time-slots`, { method: 'POST', body: JSON.stringify(body) }),
};

// セッション管理
export function saveToken(token) { localStorage.setItem('seiriken_token', token); }
export function clearToken() { localStorage.removeItem('seiriken_token'); }
export function getToken() { return localStorage.getItem('seiriken_token'); }

// idempotency key 生成
export function genKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// トースト
export function toast(msg, type = 'info', duration = 3000) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), duration);
}
