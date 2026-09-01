import { createMiddleware } from 'hono/factory';
import type { Env, SessionPayload, ScopedPermission } from './types';
import { verifyJwt, isGlobalAdmin, hasMinPermission } from './auth';
import { errorResponse } from './errors';
import { getSheetPermission, getProjectPermission, getSheet } from './db/queries';

const JWT_SECRET_KEY = 'JWT_SECRET'; // KVキー or 環境変数名

// Honoコンテキスト拡張
declare module 'hono' {
  interface ContextVariableMap {
    session: SessionPayload;
  }
}

// ============================================================
// 認証ミドルウェア（全スタッフ・管理API共通）
// ============================================================
export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return errorResponse('AUTH_REQUIRED', '認証が必要です');

  // JWT_SECRETはKVから取得（本番ではWorkers Secrets推奨）
  const secret = c.env.JWT_SECRET ?? await c.env.SESSION_KV.get(JWT_SECRET_KEY) ?? 'dev-secret-change-me';
  const payload = await verifyJwt(token, secret);
  if (!payload) return errorResponse('SESSION_EXPIRED', 'セッションが無効または期限切れです');

  // ブラックリスト確認（ログアウト済みトークン）
  const blacklisted = await c.env.SESSION_KV.get(`bl:${token}`);
  if (blacklisted) return errorResponse('SESSION_EXPIRED', 'セッションが無効です');

  c.set('session', payload);
  await next();
});

// ============================================================
// シート権限チェック
// ============================================================
export function requireSheetPermission(minPermission: ScopedPermission) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const session = c.get('session');
    if (!session) return errorResponse('AUTH_REQUIRED', '認証が必要です');

    // developer/system_admin は全シートアクセス可
    if (isGlobalAdmin(session.role)) { await next(); return; }

    const sheetId = parseInt(c.req.param('sheetId') ?? '0', 10);
    if (!sheetId) return errorResponse('VALIDATION_ERROR', 'sheetId が不正です');

    // 共有スタッフアカウントのスコープ確認
    if (session.accountType === 'shared') {
      if (session.sheetId !== sheetId) return errorResponse('FORBIDDEN', 'このシートへのアクセス権限がありません');
      if (!session.permission || !hasMinPermission(session.permission, minPermission)) {
        return errorResponse('FORBIDDEN', '操作権限が不足しています');
      }
      await next(); return;
    }

    // 個人アカウント: シート権限テーブル確認
    const perm = await getSheetPermission(c.env.DB, session.userId, sheetId);
    if (!perm || !hasMinPermission(perm.permission, minPermission)) {
      // project_manager はシート権限不要でアクセス可
      const sheet = await getSheet(c.env.DB, sheetId);
      if (sheet) {
        const projPerm = await getProjectPermission(c.env.DB, session.userId, sheet.project_id);
        if (projPerm?.permission === 'project_manager') { await next(); return; }
      }
      return errorResponse('FORBIDDEN', '操作権限が不足しています');
    }
    await next();
  });
}

// ============================================================
// システム管理者チェック
// ============================================================
export const requireSystemAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const session = c.get('session');
  if (!session) return errorResponse('AUTH_REQUIRED', '認証が必要です');
  if (!isGlobalAdmin(session.role)) return errorResponse('FORBIDDEN', 'システム管理者権限が必要です');
  await next();
});
