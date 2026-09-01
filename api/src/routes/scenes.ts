import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware';
import { isGlobalAdmin } from '../auth';
import { insertAuditLog, now } from '../db/queries';
import { errorResponse, successResponse } from '../errors';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// GET /api/scenes/:sceneId
// ============================================================
app.get('/:sceneId', requireAuth, async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  const scene   = await c.env.DB.prepare('SELECT * FROM scenes WHERE id=?').bind(sceneId).first<any>();
  if (!scene) return errorResponse('SCENE_NOT_FOUND', 'シーンが見つかりません');

  const items = await c.env.DB.prepare(
    'SELECT * FROM scene_items WHERE scene_id=? ORDER BY z_index ASC, sort_order ASC'
  ).bind(sceneId).all<any>();

  return successResponse({ scene, items: items.results });
});

// ============================================================
// POST /api/displays/:displayId/scenes
// シーン作成
// ============================================================
app.post('/displays/:displayId/scenes', requireAuth, async (c) => {
  const session = c.get('session');
  const displayId = parseInt(c.req.param('displayId'), 10);
  const body    = await c.req.json<{ sheetId: number; name: string; description?: string }>();
  if (!body.sheetId || !body.name) return errorResponse('VALIDATION_ERROR', 'sheetId, name は必須です');

  const n = now();
  const r = await c.env.DB.prepare(
    `INSERT INTO scenes (sheet_id, name, description, status, sort_order, created_at, updated_at, version)
     VALUES (?, ?, ?, 'active', 0, ?, ?, 1) RETURNING id`
  ).bind(body.sheetId, body.name, body.description ?? null, n, n).first<{ id: number }>();

  return successResponse({ id: r!.id }, 201);
});

// ============================================================
// PUT /api/scenes/:sceneId  （楽観的ロック）
// ============================================================
app.put('/:sceneId', requireAuth, async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  const session = c.get('session');
  const body    = await c.req.json<{ name?: string; items: any[]; version: number }>();

  const scene = await c.env.DB.prepare('SELECT * FROM scenes WHERE id=?').bind(sceneId).first<any>();
  if (!scene) return errorResponse('SCENE_NOT_FOUND', 'シーンが見つかりません');

  // バージョン確認（楽観的ロック）
  if (scene.version !== body.version) {
    return errorResponse('VERSION_CONFLICT', '他のユーザーが編集しています。最新版を取得してください');
  }

  // バリデーション
  if (!Array.isArray(body.items)) return errorResponse('VALIDATION_ERROR', 'items は配列必須です');
  for (const item of body.items) {
    if (!['display','text','shape','placeholder','qr'].includes(item.item_type)) {
      return errorResponse('SCENE_CONFIG_INVALID', `不正な item_type: ${item.item_type}`);
    }
    if (item.x < 0 || item.y < 0 || item.x >= 1920 || item.y >= 1080) {
      // 完全にCanvas外 → 拒否
      if (item.x >= 1920 || item.y >= 1080 || item.x + item.width <= 0 || item.y + item.height <= 0) {
        return errorResponse('SCENE_CONFIG_INVALID', 'Canvas外に完全に配置されたアイテムは保存できません');
      }
    }
  }

  const n = now();
  // scene_items を全削除→再挿入
  await c.env.DB.prepare('DELETE FROM scene_items WHERE scene_id=?').bind(sceneId).run();

  if (body.items.length > 0) {
    const inserts = body.items.map((item: any, idx: number) =>
      c.env.DB.prepare(
        `INSERT INTO scene_items (scene_id, item_type, asset_id, data_source,
         x, y, width, height, z_index, config_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(sceneId, item.item_type, item.asset_id ?? null, item.data_source ?? null,
        item.x, item.y, item.width, item.height, item.z_index ?? 0,
        item.config_json ? JSON.stringify(item.config_json) : null, idx, n, n)
    );
    await c.env.DB.batch(inserts);
  }

  await c.env.DB.prepare(
    `UPDATE scenes SET name=COALESCE(?,name), version=version+1, updated_at=? WHERE id=?`
  ).bind(body.name ?? null, n, sceneId).run();

  await insertAuditLog(c.env.DB, {
    actor_type: 'manager', user_id: session?.userId ?? null, sheet_id: scene.sheet_id,
    action: 'scene.save', target_type: 'scene', target_id: sceneId,
    details_json: null,
  });

  return successResponse({ sceneId, newVersion: body.version + 1 });
});

// ============================================================
// POST /api/scenes/:sceneId/activate  （Scene切替・project_manager以上）
// ============================================================
app.post('/:sceneId/activate', requireAuth, async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  const session = c.get('session');
  const body    = await c.req.json<{ displayId: number }>();

  // project_manager以上のみ
  const allowed = isGlobalAdmin(session.role) || session.permission === 'project_manager';
  if (!allowed) return errorResponse('FORBIDDEN', 'Scene切替はproject_manager以上の権限が必要です');

  const scene   = await c.env.DB.prepare('SELECT * FROM scenes WHERE id=?').bind(sceneId).first<any>();
  if (!scene) return errorResponse('SCENE_NOT_FOUND', 'シーンが見つかりません');

  const display = await c.env.DB.prepare('SELECT * FROM display_configs WHERE id=?').bind(body.displayId).first<any>();
  if (!display) return errorResponse('DISPLAY_NOT_FOUND', 'Displayが見つかりません');

  // SceneとDisplayが同一Project配下であることを確認
  const sheet = await c.env.DB.prepare('SELECT * FROM sheets WHERE id=?').bind(scene.sheet_id).first<any>();
  if (!sheet || sheet.project_id !== display.project_id) {
    return errorResponse('FORBIDDEN', 'SceneとDisplayが異なるProjectに属しています');
  }

  await c.env.DB.prepare(
    'UPDATE display_configs SET current_scene_id=?, updated_at=? WHERE id=?'
  ).bind(sceneId, now(), body.displayId).run();

  await insertAuditLog(c.env.DB, {
    actor_type: 'manager', user_id: session?.userId ?? null, sheet_id: scene.sheet_id,
    action: 'scene.activate', target_type: 'display_config', target_id: body.displayId,
    details_json: JSON.stringify({ sceneId }),
  });

  return successResponse({ message: 'Scene切替完了', sceneId, displayId: body.displayId });
});

// ============================================================
// DELETE /api/scenes/:sceneId
// ============================================================
app.delete('/:sceneId', requireAuth, async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  const session = c.get('session');
  // sheet_manager以上
  await c.env.DB.prepare('UPDATE scenes SET status=?, updated_at=? WHERE id=?').bind('archived', now(), sceneId).run();
  await insertAuditLog(c.env.DB, {
    actor_type: 'manager', user_id: session?.userId ?? null, sheet_id: null,
    action: 'scene.delete', target_type: 'scene', target_id: sceneId, details_json: null,
  });
  return successResponse({ message: '削除しました' });
});

export default app;
