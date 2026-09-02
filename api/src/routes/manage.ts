import { Hono } from 'hono';
import type { Env } from '../types';
import { hashPassword, isGlobalAdmin } from '../auth';
import { requireAuth, requireSheetPermission, requireSystemAdmin } from '../middleware';
import { errorResponse, successResponse } from '../errors';
import { now } from '../db/queries';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// 企画 CRUD
// ============================================================
app.get('/projects', requireAuth, async (c) => {
  const session = c.get('session');
  let rows;
  if (isGlobalAdmin(session.role)) {
    rows = await c.env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC').all<any>();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT p.* FROM projects p JOIN user_project_permissions pp ON pp.project_id=p.id
       WHERE pp.user_id=? AND pp.permission='project_manager' ORDER BY p.created_at DESC`
    ).bind(session.userId).all<any>();
  }
  return successResponse({ projects: rows.results });
});

app.get('/projects/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first<any>();
  if (!project) return errorResponse('PROJECT_NOT_FOUND', '企画が見つかりません');
  const sheets = await c.env.DB.prepare('SELECT * FROM sheets WHERE project_id=? ORDER BY id').bind(id).all<any>();
  return successResponse({ project, sheets: sheets.results });
});

app.post('/projects', requireAuth, requireSystemAdmin, async (c) => {
  const body = await c.req.json<{ name: string; description?: string }>();
  if (!body.name) return errorResponse('VALIDATION_ERROR', 'name は必須です');
  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO projects (name,description,status,created_at,updated_at) VALUES (?,?,'active',?,?) RETURNING id`
  ).bind(body.name, body.description ?? null, n, n).first<{ id: number }>();
  return successResponse({ id: r!.id }, 201);
});

app.put('/projects/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ name?: string; description?: string; status?: string }>();
  await c.env.DB.prepare(
    'UPDATE projects SET name=COALESCE(?,name),description=COALESCE(?,description),status=COALESCE(?,status),updated_at=? WHERE id=?'
  ).bind(body.name??null, body.description??null, body.status??null, now(), id).run();
  return successResponse({ message: '更新しました' });
});

// ============================================================
// シート CRUD
// ============================================================
app.post('/projects/:projectId/sheets', requireAuth, async (c) => {
  const projectId = parseInt(c.req.param('projectId'), 10);
  const session = c.get('session');
  if (!isGlobalAdmin(session.role)) {
    const p = await c.env.DB.prepare(
      'SELECT id FROM user_project_permissions WHERE user_id=? AND project_id=? AND permission=?'
    ).bind(session.userId, projectId, 'project_manager').first();
    if (!p) return errorResponse('FORBIDDEN', '権限が不足しています');
  }
  const body = await c.req.json<{ name: string; ticketPrefix: string; ticketDigits?: number }>();
  if (!body.name || !body.ticketPrefix) return errorResponse('VALIDATION_ERROR', 'name, ticketPrefix は必須です');
  if (!/^[A-Z0-9]{2,4}$/.test(body.ticketPrefix.toUpperCase())) {
    return errorResponse('VALIDATION_ERROR', 'プレフィックスは英大文字・数字2〜4文字です');
  }
  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO sheets (project_id,name,ticket_prefix,ticket_digits,ticket_next_number,entry_enabled,status,created_at,updated_at)
     VALUES (?,?,?,?,1,0,'active',?,?) RETURNING id`
  ).bind(projectId, body.name, body.ticketPrefix.toUpperCase(), body.ticketDigits??4, n, n).first<{ id: number }>();
  return successResponse({ id: r!.id }, 201);
});

app.put('/sheets/:sheetId', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body = await c.req.json<{ name?: string; entryEnabled?: boolean; status?: string }>();
  await c.env.DB.prepare(
    'UPDATE sheets SET name=COALESCE(?,name),entry_enabled=COALESCE(?,entry_enabled),status=COALESCE(?,status),updated_at=? WHERE id=?'
  ).bind(body.name??null, body.entryEnabled!==undefined?(body.entryEnabled?1:0):null, body.status??null, now(), sheetId).run();
  return successResponse({ message: '更新しました' });
});

// ============================================================
// 時間帯 CRUD
// ============================================================
app.post('/sheets/:sheetId/time-slots', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body = await c.req.json<{
    name: string; startAt: string; endAt: string; capacityGroups: number;
    callStartAt: string; callEndAt: string; expireAt: string; sortOrder?: number;
  }>();
  if (!body.name || !body.startAt || !body.endAt || !body.capacityGroups) {
    return errorResponse('VALIDATION_ERROR', '必須項目が不足しています');
  }
  if (body.startAt >= body.endAt) return errorResponse('INVALID_TIME_RANGE', 'start_at < end_at が必要です');
  if (body.callEndAt > body.expireAt) return errorResponse('INVALID_TIME_RANGE', 'call_end_at <= expire_at が必要です');
  const overlap = await c.env.DB.prepare(
    `SELECT id FROM time_slots WHERE sheet_id=? AND status!='archived' AND NOT (end_at<=? OR start_at>=?)`
  ).bind(sheetId, body.startAt, body.endAt).first();
  if (overlap) return errorResponse('TIME_SLOT_OVERLAP', '時間帯が重複しています');
  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO time_slots (sheet_id,name,start_at,end_at,capacity_groups,call_start_at,call_end_at,expire_at,sort_order,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'active',?,?) RETURNING id`
  ).bind(sheetId,body.name,body.startAt,body.endAt,body.capacityGroups,body.callStartAt,body.callEndAt,body.expireAt,body.sortOrder??0,n,n).first<{ id: number }>();
  return successResponse({ id: r!.id }, 201);
});

app.put('/time-slots/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ name?: string; capacityGroups?: number; callStartAt?: string; callEndAt?: string; expireAt?: string; status?: string }>();
  await c.env.DB.prepare(
    `UPDATE time_slots SET name=COALESCE(?,name),capacity_groups=COALESCE(?,capacity_groups),
     call_start_at=COALESCE(?,call_start_at),call_end_at=COALESCE(?,call_end_at),
     expire_at=COALESCE(?,expire_at),status=COALESCE(?,status),updated_at=? WHERE id=?`
  ).bind(body.name??null,body.capacityGroups??null,body.callStartAt??null,body.callEndAt??null,body.expireAt??null,body.status??null,now(),id).run();
  return successResponse({ message: '更新しました' });
});

app.delete('/time-slots/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare("UPDATE time_slots SET status='archived',updated_at=? WHERE id=?").bind(now(),id).run();
  return successResponse({ message: '削除しました' });
});

// ============================================================
// シート詳細（時間帯・スタッフ・注意事項を一括取得）
// ============================================================
app.get('/sheets/:sheetId/detail', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const [sheet, slots, users, notices] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM sheets WHERE id=?').bind(sheetId).first<any>(),
    c.env.DB.prepare("SELECT * FROM time_slots WHERE sheet_id=? AND status!='archived' ORDER BY start_at").bind(sheetId).all<any>(),
    c.env.DB.prepare(
      `SELECT u.id,u.username,u.display_name,u.account_type,u.status,p.permission,p.id as permission_id
       FROM users u JOIN user_sheet_permissions p ON p.user_id=u.id WHERE p.sheet_id=?`
    ).bind(sheetId).all<any>(),
    c.env.DB.prepare("SELECT * FROM sheet_notices WHERE sheet_id=? AND status='active' ORDER BY screen_type,sort_order").bind(sheetId).all<any>(),
  ]);
  return successResponse({ sheet, timeSlots: slots.results, users: users.results, notices: notices.results });
});

// ============================================================
// スタッフアカウント作成
// ============================================================
app.post('/sheets/:sheetId/users', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const session = c.get('session');
  const body = await c.req.json<{ username: string; password: string; displayName: string; permission: string; accountType?: string }>();
  if (!body.username||!body.password||!body.displayName||!body.permission) return errorResponse('VALIDATION_ERROR','必須項目が不足しています');
  if (body.password.length < 6) return errorResponse('VALIDATION_ERROR','パスワードは6文字以上です');
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(body.username).first();
  if (dup) return errorResponse('VALIDATION_ERROR','そのユーザー名は既に使用されています');
  const hash = await hashPassword(body.password);
  const n = now();
  const ur = await c.env.DB.prepare(
    `INSERT INTO users (username,password_hash,account_type,display_name,role,status,created_at,updated_at)
     VALUES (?,?,?,'user','active',?,?) RETURNING id`
  ).bind(body.username, hash, body.accountType??'shared', body.displayName, n, n).first<{ id: number }>();
  await c.env.DB.prepare(
    'INSERT INTO user_sheet_permissions (user_id,sheet_id,permission,created_at) VALUES (?,?,?,?)'
  ).bind(ur!.id, sheetId, body.permission, n).run();
  return successResponse({ id: ur!.id, username: body.username }, 201);
});

// ============================================================
// 注意事項 CRUD
// ============================================================
app.post('/sheets/:sheetId/notices', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const body = await c.req.json<{ screenType: string; title?: string; body: string; sortOrder?: number }>();
  if (!body.screenType||!body.body) return errorResponse('VALIDATION_ERROR','screenType,body は必須です');
  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO sheet_notices (sheet_id,screen_type,title,body,sort_order,status,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?) RETURNING id`
  ).bind(sheetId,body.screenType,body.title??null,body.body,body.sortOrder??0,n,n).first<{ id: number }>();
  return successResponse({ id: r!.id }, 201);
});

app.put('/notices/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ title?: string; body?: string; status?: string; sortOrder?: number }>();
  await c.env.DB.prepare(
    'UPDATE sheet_notices SET title=COALESCE(?,title),body=COALESCE(?,body),status=COALESCE(?,status),sort_order=COALESCE(?,sort_order),updated_at=? WHERE id=?'
  ).bind(body.title??null,body.body??null,body.status??null,body.sortOrder??null,now(),id).run();
  return successResponse({ message: '更新しました' });
});

app.delete('/notices/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare("UPDATE sheet_notices SET status='inactive',updated_at=? WHERE id=?").bind(now(),id).run();
  return successResponse({ message: '削除しました' });
});

// ============================================================
// ユーザー管理（system_admin以上）
// ============================================================
app.get('/users', requireAuth, requireSystemAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id,username,display_name,account_type,role,status,created_at FROM users ORDER BY created_at DESC'
  ).all<any>();
  return successResponse({ users: rows.results });
});

app.post('/users', requireAuth, requireSystemAdmin, async (c) => {
  const body = await c.req.json<{ username: string; password: string; displayName: string; role?: string }>();
  if (!body.username||!body.password||!body.displayName) return errorResponse('VALIDATION_ERROR','必須項目が不足しています');
  if (body.password.length < 6) return errorResponse('VALIDATION_ERROR','パスワードは6文字以上です');
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(body.username).first();
  if (dup) return errorResponse('VALIDATION_ERROR','そのユーザー名は既に使用されています');
  const hash = await hashPassword(body.password);
  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO users (username,password_hash,account_type,display_name,role,status,created_at,updated_at)
     VALUES (?,?,'personal',?,?,'active',?,?) RETURNING id`
  ).bind(body.username,hash,body.displayName,body.role??'user',n,n).first<{ id: number }>();
  return successResponse({ id: r!.id }, 201);
});

app.put('/users/:id/status', requireAuth, requireSystemAdmin, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ status: string }>();
  if (!['active','inactive'].includes(body.status)) return errorResponse('VALIDATION_ERROR','無効なステータスです');
  await c.env.DB.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').bind(body.status,now(),id).run();
  return successResponse({ message: '更新しました' });
});

app.put('/users/:id/password', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ password: string }>();
  if (!body.password||body.password.length<6) return errorResponse('VALIDATION_ERROR','パスワードは6文字以上です');
  const hash = await hashPassword(body.password);
  await c.env.DB.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').bind(hash,now(),id).run();
  return successResponse({ message: 'パスワードを変更しました' });
});

app.get('/users/search', requireAuth, async (c) => {
  const q = c.req.query('q')??'';
  if (!q) return successResponse({ users: [] });
  const rows = await c.env.DB.prepare(
    "SELECT id,username,display_name,role FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND status='active' LIMIT 10"
  ).bind(`%${q}%`,`%${q}%`).all<any>();
  return successResponse({ users: rows.results });
});

// ============================================================
// プロジェクト権限
// ============================================================
app.get('/projects/:id/permissions', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rows = await c.env.DB.prepare(
    `SELECT pp.id,pp.permission,u.id as user_id,u.username,u.display_name,u.role
     FROM user_project_permissions pp JOIN users u ON u.id=pp.user_id WHERE pp.project_id=? ORDER BY pp.created_at`
  ).bind(id).all<any>();
  return successResponse({ permissions: rows.results });
});

app.post('/projects/:id/permissions', requireAuth, async (c) => {
  const projectId = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ userId: number; permission: string }>();
  if (!body.userId||!body.permission) return errorResponse('VALIDATION_ERROR','必須項目が不足しています');
  const ex = await c.env.DB.prepare(
    'SELECT id FROM user_project_permissions WHERE user_id=? AND project_id=?'
  ).bind(body.userId,projectId).first();
  if (ex) {
    await c.env.DB.prepare('UPDATE user_project_permissions SET permission=? WHERE user_id=? AND project_id=?').bind(body.permission,body.userId,projectId).run();
  } else {
    await c.env.DB.prepare('INSERT INTO user_project_permissions (user_id,project_id,permission,created_at) VALUES (?,?,?,?)').bind(body.userId,projectId,body.permission,now()).run();
  }
  return successResponse({ message: '設定しました' });
});

app.delete('/project-permissions/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM user_project_permissions WHERE id=?').bind(id).run();
  return successResponse({ message: '削除しました' });
});

app.delete('/sheet-permissions/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM user_sheet_permissions WHERE id=?').bind(id).run();
  return successResponse({ message: '削除しました' });
});

// ============================================================
// Display設定
// ============================================================
app.get('/projects/:id/displays', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rows = await c.env.DB.prepare(
    `SELECT d.*,s.name as current_scene_name FROM display_configs d
     LEFT JOIN scenes s ON s.id=d.current_scene_id WHERE d.project_id=? ORDER BY d.display_slot`
  ).bind(id).all<any>();
  return successResponse({ displays: rows.results });
});

app.post('/projects/:id/displays', requireAuth, async (c) => {
  const projectId = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ name: string; displaySlot: number; displayType?: string }>();
  if (!body.name||!body.displaySlot) return errorResponse('VALIDATION_ERROR','必須項目が不足しています');
  if (![1,2].includes(body.displaySlot)) return errorResponse('VALIDATION_ERROR','displaySlotは1または2です');
  const dup = await c.env.DB.prepare('SELECT id FROM display_configs WHERE project_id=? AND display_slot=?').bind(projectId,body.displaySlot).first();
  if (dup) return errorResponse('VALIDATION_ERROR',`Display ${body.displaySlot}は既に作成済みです`);
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) as n FROM display_configs WHERE project_id=?').bind(projectId).first<{n:number}>();
  if ((cnt?.n??0)>=2) return errorResponse('VALIDATION_ERROR','企画あたりDisplayは最大2台です');
  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO display_configs (project_id,name,display_key,display_slot,display_type,status,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?) RETURNING id`
  ).bind(projectId,body.name,`proj-${projectId}-disp-${body.displaySlot}`,body.displaySlot,body.displayType??'monitor',n,n).first<{ id: number }>();
  return successResponse({ id: r!.id }, 201);
});

app.put('/displays/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ name?: string; displayType?: string; status?: string }>();
  await c.env.DB.prepare(
    'UPDATE display_configs SET name=COALESCE(?,name),display_type=COALESCE(?,display_type),status=COALESCE(?,status),updated_at=? WHERE id=?'
  ).bind(body.name??null,body.displayType??null,body.status??null,now(),id).run();
  return successResponse({ message: '更新しました' });
});

// ============================================================
// シーン一覧
// ============================================================
app.get('/sheets/:sheetId/scenes', requireAuth, requireSheetPermission('sheet_manager'), async (c) => {
  const sheetId = parseInt(c.req.param('sheetId'), 10);
  const rows = await c.env.DB.prepare(
    "SELECT id,name,description,status,sort_order,version,created_at FROM scenes WHERE sheet_id=? AND status!='archived' ORDER BY sort_order,created_at"
  ).bind(sheetId).all<any>();
  return successResponse({ scenes: rows.results });
});

export default app;