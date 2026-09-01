import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserByUsername, getSheetPermission } from '../db/queries';
import { verifyPassword, signJwt } from '../auth';
import { errorResponse, successResponse } from '../errors';
import { requireAuth } from '../middleware';

const app = new Hono<{ Bindings: Env }>();
const JWT_SECRET_KEY = 'JWT_SECRET';

// POST /api/auth/login
app.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  if (!body.username || !body.password) {
    return errorResponse('VALIDATION_ERROR', 'username と password は必須です');
  }

  const user = await getUserByUsername(c.env.DB, body.username);
  if (!user) return errorResponse('INVALID_CREDENTIALS', 'ユーザー名またはパスワードが違います');

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) return errorResponse('INVALID_CREDENTIALS', 'ユーザー名またはパスワードが違います');

  const secret = c.env.JWT_SECRET ?? await c.env.SESSION_KV.get(JWT_SECRET_KEY) ?? 'dev-secret-change-me';

  // 共有スタッフアカウントはシートスコープを付与
  let sheetId: number | undefined;
  let permission: string | undefined;
  if (user.account_type === 'shared') {
    const perms = await c.env.DB.prepare(
      'SELECT * FROM user_sheet_permissions WHERE user_id = ? LIMIT 1'
    ).bind(user.id).first<{ sheet_id: number; permission: string }>();
    if (perms) { sheetId = perms.sheet_id; permission = perms.permission; }
  }

  const token = await signJwt({
    userId: user.id,
    username: user.username,
    role: user.role,
    accountType: user.account_type,
    sheetId,
    permission: permission as any,
    exp: 0, // signJwt内で上書き
  }, secret);

  return successResponse({
    token,
    user: {
      id: user.id,
      displayName: user.display_name,
      role: user.role,
      accountType: user.account_type,
      sheetId,
      permission,
    }
  });
});

// POST /api/auth/logout
app.post('/logout', requireAuth, async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token) {
    // 12時間ブラックリスト
    await c.env.SESSION_KV.put(`bl:${token}`, '1', { expirationTtl: 43200 });
  }
  return successResponse({ message: 'ログアウトしました' });
});

export default app;
