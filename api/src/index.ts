import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { runScheduler } from './scheduler';

import authRoutes    from './routes/auth';
import publicRoutes  from './routes/public';
import staffRoutes   from './routes/staff';
import manageRoutes  from './routes/manage';
import displayRoutes from './routes/display';
import sceneRoutes   from './routes/scenes';
import setupRoutes   from './routes/setup';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: (origin) => origin ?? '*',
  allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowHeaders: ['Content-Type','Authorization','Idempotency-Key'],
  credentials: true,
}));

app.get('/api/health', (c) => c.json({ ok: true, service: 'seiriken-api', time: new Date().toISOString() }));

app.route('/api/auth',    authRoutes);
app.route('/api/public',  publicRoutes);
app.route('/api/staff',   staffRoutes);
app.route('/api/manage',  manageRoutes);
app.route('/api',         displayRoutes);
app.route('/api/scenes',  sceneRoutes);
app.route('/api/setup',   setupRoutes);  // 初回セットアップ用

app.notFound((c) => c.json({ ok:false, error:{ code:'NOT_FOUND', message:'エンドポイントが見つかりません' } }, 404));
app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ ok:false, error:{ code:'INTERNAL_ERROR', message:'サーバーエラーが発生しました' } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduler(env));
  },
};