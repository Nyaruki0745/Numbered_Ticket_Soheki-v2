import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types';
import { runScheduler } from './scheduler';

import authRoutes    from './routes/auth';
import publicRoutes  from './routes/public';
import staffRoutes   from './routes/staff';
import manageRoutes  from './routes/manage';
import displayRoutes from './routes/display';
import sceneRoutes   from './routes/scenes';

const app = new Hono<{ Bindings: Env }>();

// ── グローバルミドルウェア ───────────────────────────────────
app.use('*', cors({
  origin: (origin) => origin ?? '*', // Pages/フロントのオリジンを許可
  allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowHeaders: ['Content-Type','Authorization','Idempotency-Key'],
  exposeHeaders: ['Content-Length'],
  credentials: true,
}));

// 開発時のみ logger


// ── ヘルスチェック ──────────────────────────────────────────
app.get('/api/health', (c) => c.json({ ok: true, service: 'seiriken-api', time: new Date().toISOString() }));

// ── ルート登録 ──────────────────────────────────────────────
app.route('/api/auth',    authRoutes);
app.route('/api/public',  publicRoutes);
app.route('/api/staff',   staffRoutes);
app.route('/api/manage',  manageRoutes);
app.route('/api',         displayRoutes);  // /api/sheets/:id/call-status など
app.route('/api/scenes',  sceneRoutes);

// ── 404 ────────────────────────────────────────────────────
app.notFound((c) => c.json({ ok: false, error: { code: 'NOT_FOUND', message: 'エンドポイントが見つかりません' } }, 404));

// ── エラーハンドラ ──────────────────────────────────────────
app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }, 500);
});

// ── Cloudflare Workers エクスポート ─────────────────────────
export default {
  // HTTP リクエスト
  fetch: app.fetch,

  // Cron Trigger（毎分）
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduler(env));
  },
};
