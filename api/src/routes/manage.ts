import { Hono } from 'hono';
import type { Env } from '../types';
import { hashPassword } from '../auth';
import { requireAuth, requireSheetPermission, requireSystemAdmin } from '../middleware';
import { errorResponse, successResponse } from '../errors';
import { isGlobalAdmin, hasMinPermission } from '../auth';
import { now } from '../db/queries';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// 企画 CRUD
// ============================================================
app.post('/projects', requireAuth, requireSystemAdmin, async (c) => {
  const body = await c.req.json<{ name: string; description?: string }>();
  if (!body.name) return errorResponse('VALIDATION_ERROR', 'name は必須です');

  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO projects (name, description, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?) RETURNING id`
  ).bind(body.name, body.description ?? null, n, n).first<{ id: number }>();

  return successResponse({ id: r!.id, name: body.name }, 201);
});

app.put('/projects/:id', requireAuth, requireSystemAdmin, async (c) => {
  const id   = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ name?: string; description?: string; status?: string }>();
  await c.env.DB.prepare(
    `UPDATE projects SET name=COALESCE(?,name), description=COALESCE(?,description),
     status=COALESCE(?,status), updated_at=? WHERE id=?`
  ).bind(body.name ?? null, body.description ?? null, body.status ?? null, now(), id).run();
  return successResponse({ message: '更新しました' });
});

// ============================================================
// シート CRUD
// ============================================================
app.post('/projects/:projectId/sheets', requireAuth, async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  const session   = c.get('session');
  if (!isGlobalAdmin(session.role)) {
    const perm = await c.env.DB.prepare(
      'SELECT * FROM user_project_permissions WHERE user_id=? AND project_id=?'
    ).bind(session.userId, projectId).first<any>();
    if (perm?.permission !== 'project_manager') return errorResponse('FORBIDDEN', '権限が不足しています');
  }

  const body = await c.req.json<{ name: string; ticketPrefix: string; ticketDigits?: number }>();
  if (!body.name || !body.ticketPrefix) return errorResponse('VALIDATION_ERROR', 'name, ticketPrefix は必須です');

  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO sheets (project_id, name, ticket_prefix, ticket_digits, ticket_next_number,
     entry_enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, 'active', ?, ?) RETURNING id`
  ).bind(projectId, body.name, body.ticketPrefix.toUpperCase(), body.ticketDigits ?? 4, n, n).first<{ id: number }>();

  return successResponse({ id: r!.id }, 201);
});

app.put('/sheets/:sheetId', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body    = await c.req.json<{ name?: string; entryEnabled?: boolean; status?: string }>();
  await c.env.DB.prepare(
    `UPDATE sheets SET name=COALESCE(?,name), entry_enabled=COALESCE(?,entry_enabled),
     status=COALESCE(?,status), updated_at=? WHERE id=?`
  ).bind(body.name ?? null, body.entryEnabled !== undefined ? (body.entryEnabled ? 1 : 0) : null,
    body.status ?? null, now(), sheetId).run();
  return successResponse({ message: '更新しました' });
});

// ============================================================
// 時間帯 CRUD
// ============================================================
app.post('/sheets/:sheetId/time-slots', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body    = await c.req.json<{
    name: string; startAt: string; endAt: string; capacityGroups: number;
    callStartAt: string; callEndAt: string; expireAt: string; sortOrder?: number;
  }>();

  if (!body.name || !body.startAt || !body.endAt || !body.capacityGroups) {
    return errorResponse('VALIDATION_ERROR', '必須項目が不足しています');
  }
  if (body.startAt >= body.endAt) return errorResponse('INVALID_TIME_RANGE', 'start_at < end_at が必要です');
  if (body.callEndAt > body.expireAt) return errorResponse('INVALID_TIME_RANGE', 'call_end_at <= expire_at が必要です');

  // 時間帯重複チェック
  const overlap = await c.env.DB.prepare(
    `SELECT id FROM time_slots WHERE sheet_id = ? AND status != 'archived'
     AND NOT (end_at <= ? OR start_at >= ?)`
  ).bind(sheetId, body.startAt, body.endAt).first();
  if (overlap) return errorResponse('TIME_SLOT_OVERLAP', '時間帯が重複しています');

  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO time_slots (sheet_id, name, start_at, end_at, capacity_groups,
     call_start_at, call_end_at, expire_at, sort_order, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING id`
  ).bind(sheetId, body.name, body.startAt, body.endAt, body.capacityGroups,
    body.callStartAt, body.callEndAt, body.expireAt, body.sortOrder ?? 0, n, n
  ).first<{ id: number }>();

  return successResponse({ id: r!.id }, 201);
});

app.put('/time-slots/:id', requireAuth, async (c) => {
  const id   = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ name?: string; capacityGroups?: number; status?: string }>();
  await c.env.DB.prepare(
    `UPDATE time_slots SET name=COALESCE(?,name), capacity_groups=COALESCE(?,capacity_groups),
     status=COALESCE(?,status), updated_at=? WHERE id=?`
  ).bind(body.name ?? null, body.capacityGroups ?? null, body.status ?? null, now(), id).run();
  return successResponse({ message: '更新しました' });
});

// ============================================================
// ユーザー作成
// ============================================================
app.post('/sheets/:sheetId/users', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const session = c.get('session');
  const body    = await c.req.json<{
    username: string; password: string; displayName: string;
    permission: string; accountType?: string;
  }>();

  if (!body.username || !body.password || !body.displayName || !body.permission) {
    return errorResponse('VALIDATION_ERROR', '必須項目が不足しています');
  }

  // 自分より上位の権限は付与不可
  const permitted: Record<string, string[]> = {
    project_manager: ['sheet_manager','staff','viewer'],
    sheet_manager:   ['staff','viewer'],
  };
  const myPerm = session.permission ?? (isGlobalAdmin(session.role) ? 'project_manager' : 'viewer');
  if (!permitted[myPerm]?.includes(body.permission)) {
    return errorResponse('FORBIDDEN', '自分より上位の権限は付与できません');
  }

  const hash = await hashPassword(body.password);
  const n    = now();

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(body.username).first();
  if (existing) return errorResponse('VALIDATION_ERROR', 'そのユーザー名は既に使用されています');

  const ur = await c.env.DB.prepare(
    `INSERT INTO users (username, password_hash, account_type, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', 'active', ?, ?) RETURNING id`
  ).bind(body.username, hash, body.accountType ?? 'shared', body.displayName, n, n).first<{ id: number }>();

  await c.env.DB.prepare(
    `INSERT INTO user_sheet_permissions (user_id, sheet_id, permission, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(ur!.id, sheetId, body.permission, n).run();

  return successResponse({ id: ur!.id, username: body.username }, 201);
});

// ============================================================
// 注意事項 CRUD
// ============================================================
app.post('/sheets/:sheetId/notices', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body    = await c.req.json<{ screenType: string; title?: string; body: string; sortOrder?: number }>();
  if (!body.screenType || !body.body) return errorResponse('VALIDATION_ERROR', 'screenType, body は必須です');

  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO sheet_notices (sheet_id, screen_type, title, body, sort_order, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?) RETURNING id`
  ).bind(sheetId, body.screenType, body.title ?? null, body.body, body.sortOrder ?? 0, n, n).first<{ id: number }>();

  return successResponse({ id: r!.id }, 201);
});

app.put('/notices/:id', requireAuth, async (c) => {
  const id   = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ title?: string; body?: string; status?: string; sortOrder?: number }>();
  await c.env.DB.prepare(
    `UPDATE sheet_notices SET title=COALESCE(?,title), body=COALESCE(?,body),
     status=COALESCE(?,status), sort_order=COALESCE(?,sort_order), updated_at=? WHERE id=?`
  ).bind(body.title ?? null, body.body ?? null, body.status ?? null, body.sortOrder ?? null, now(), id).run();
  return successResponse({ message: '更新しました' });
});

export default app;

// ============================================================
// GET エンドポイント（管理画面用）
// ============================================================

// GET /api/manage/projects
app.get('/projects', requireAuth, async (c) => {
  const session = c.get('session');
  let projects;
  if (isGlobalAdmin(session.role)) {
    projects = await c.env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC').all<any>();
  } else {
    projects = await c.env.DB.prepare(
      `SELECT p.* FROM projects p
       JOIN user_project_permissions pp ON pp.project_id = p.id
       WHERE pp.user_id = ? AND pp.permission = 'project_manager'
       ORDER BY p.created_at DESC`
    ).bind(session.userId).all<any>();
  }
  return successResponse({ projects: projects.results });
});

// GET /api/manage/projects/:id
app.get('/projects/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first<any>();
  if (!project) return errorResponse('PROJECT_NOT_FOUND', '企画が見つかりません');
  const sheets = await c.env.DB.prepare('SELECT * FROM sheets WHERE project_id=? ORDER BY id').bind(id).all<any>();
  return successResponse({ project, sheets: sheets.results });
});

// GET /api/manage/sheets/:sheetId/detail
app.get('/sheets/:sheetId/detail', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const [sheet, slots, users, notices] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM sheets WHERE id=?').bind(sheetId).first<any>(),
    c.env.DB.prepare('SELECT * FROM time_slots WHERE sheet_id=? ORDER BY start_at').bind(sheetId).all<any>(),
    c.env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.account_type, u.status, p.permission
       FROM users u JOIN user_sheet_permissions p ON p.user_id=u.id WHERE p.sheet_id=?`
    ).bind(sheetId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sheet_notices WHERE sheet_id=? ORDER BY screen_type, sort_order').bind(sheetId).all<any>(),
  ]);
  return successResponse({ sheet, timeSlots: slots.results, users: users.results, notices: notices.results });
});

// PUT /api/manage/users/:id/password
app.put('/users/:id/password', requireAuth, async (c) => {
  const id   = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ password: string }>();
  if (!body.password || body.password.length < 6) return errorResponse('VALIDATION_ERROR', 'パスワードは6文字以上です');
  const { hashPassword } = await import('../auth');
  const hash = await hashPassword(body.password);
  await c.env.DB.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').bind(hash, now(), id).run();
  return successResponse({ message: 'パスワードを変更しました' });
});

// DELETE /api/manage/time-slots/:id
app.delete('/time-slots/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare("UPDATE time_slots SET status='archived', updated_at=? WHERE id=?").bind(now(), id).run();
  return successResponse({ message: '削除しました' });
});

// DELETE /api/manage/notices/:id
app.delete('/notices/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare("UPDATE sheet_notices SET status='inactive', updated_at=? WHERE id=?").bind(now(), id).run();
  return successResponse({ message: '削除しました' });
});
