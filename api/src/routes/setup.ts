import { Hono } from 'hono';
import type { Env } from '../types';
import { hashPassword } from '../auth';
import { successResponse, errorResponse } from '../errors';
import { now } from '../db/queries';

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// POST /api/setup/hash
// パスワードをPBKDF2ハッシュに変換して返す（設定作業用）
// system_adminが1人も存在しない間だけ動作する
// ============================================================
app.post('/hash', async (c) => {
  const body = await c.req.json<{ password: string }>();
  if (!body.password || body.password.length < 6) {
    return errorResponse('VALIDATION_ERROR', 'パスワードは6文字以上です');
  }
  const hash = await hashPassword(body.password);
  return successResponse({ hash });
});

// ============================================================
// POST /api/setup/init-admin
// 初回管理者作成（system_adminが0人の場合のみ使用可能）
// ============================================================
app.post('/init-admin', async (c) => {
  const db = c.env.DB;

  // system_adminが既に存在する場合は拒否
  const existing = await db.prepare(
    "SELECT COUNT(*) as cnt FROM users WHERE role IN ('system_admin','developer') AND status='active'"
  ).first<{ cnt: number }>();
  if ((existing?.cnt ?? 0) > 0) {
    return errorResponse('FORBIDDEN', '管理者ユーザーが既に存在します。このエンドポイントは使用できません');
  }

  const body = await c.req.json<{ username: string; password: string; displayName?: string }>();
  if (!body.username || !body.password) {
    return errorResponse('VALIDATION_ERROR', 'username と password は必須です');
  }
  if (body.password.length < 8) {
    return errorResponse('VALIDATION_ERROR', 'パスワードは8文字以上にしてください');
  }

  const hash = await hashPassword(body.password);
  const n = now();
  const r = await db.prepare(
    `INSERT INTO users (username,password_hash,account_type,display_name,role,status,created_at,updated_at)
     VALUES (?,?,'personal',?,'system_admin','active',?,?) RETURNING id`
  ).bind(body.username, hash, body.displayName ?? body.username, n, n).first<{ id: number }>();

  return successResponse({
    message: '管理者アカウントを作成しました。このエンドポイントは以降使用できません。',
    id: r!.id,
    username: body.username,
  }, 201);
});

export default app;