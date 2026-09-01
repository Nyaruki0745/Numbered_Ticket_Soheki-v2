# 整理券システム v2

文化祭体験型企画向け整理券管理システム

## 技術スタック
- **API**: Cloudflare Workers + Hono + TypeScript
- **DB**: Cloudflare D1（SQLite）
- **セッション**: JWT（Cloudflare Workers KV）
- **フロントエンド**: Vanilla JS（Cloudflare Pages）
- **スケジューラ**: Cloudflare Cron Triggers（毎分）

---

## セットアップ手順

### 1. Cloudflareアカウント作成
https://cloudflare.com にアクセスしてアカウントを作成する。

### 2. Wranglerログイン
```bash
cd api
npx wrangler login
```

### 3. D1データベース作成
```bash
npx wrangler d1 create seiriken-db
```
出力された `database_id` を `wrangler.toml` の `database_id` に記入する。

### 4. KV Namespace作成
```bash
npx wrangler kv:namespace create SESSION_KV
```
出力された `id` を `wrangler.toml` の KV `id` に記入する。

### 5. wrangler.toml 更新
```toml
[[d1_databases]]
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← 手順3で取得

[[kv_namespaces]]
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # ← 手順4で取得
```

### 6. DBマイグレーション実行
```bash
# ローカルテスト用
npm run db:migrate:local

# 本番
npm run db:migrate:remote
```

### 7. JWT_SECRETをKVに設定
```bash
# ランダムな秘密鍵を設定（必ず変更すること）
npx wrangler kv:key put --binding=SESSION_KV "JWT_SECRET" "YOUR_RANDOM_SECRET_HERE"
```

### 8. 初期管理者ユーザー作成
D1コンソール（またはWrangler）で直接INSERTする：
```sql
-- パスワードは pbkdf2:salt:hash 形式（APIの /api/auth/login でhashPassword()を使用）
-- 開発中は Workers Playgroundかローカルdev環境でhashを生成する
INSERT INTO users (username, password_hash, account_type, display_name, role, status, created_at, updated_at)
VALUES ('admin', 'pbkdf2:...', 'personal', '管理者', 'system_admin', 'active', datetime('now'), datetime('now'));
```

### 9. APIデプロイ
```bash
npm run deploy
```
デプロイ後のURLをメモする（例: `https://seiriken-api.your-name.workers.dev`）

### 10. フロントエンドデプロイ（Cloudflare Pages）
1. Cloudflare Dashboard → Pages → プロジェクト作成
2. GitHubリポジトリを接続（またはDirect Uploadで `frontend/` フォルダをアップロード）
3. フロントエンドのURLからAPIを呼び出せるようCORS設定が自動で適用される

---

## 開発環境での動作確認

```bash
cd api

# ローカルでWorkerを起動（D1もローカルで使用可）
npm run dev
```

別ターミナルで：
```bash
# ヘルスチェック
curl http://localhost:8787/api/health

# スタッフアカウント作成（開発用）
# まずhashを生成してDBにinsertする
```

---

## 画面一覧

| 画面 | URL | 用途 |
|------|-----|------|
| 予約 | `/reserve.html?sheet=1` | 来場者が予約する（シートID指定） |
| スタッフ | `/staff.html` | 受付・呼出・不在処理 |
| 呼出モニター | `/monitor.html?sheet=1` | 大画面表示（パスワード不要） |
| 受付状況 | `/stats.html` | 時間帯別統計（ログイン必要） |

---

## APIエンドポイント概要

### 公開API（認証不要）
| メソッド | パス | 説明 |
|---------|------|------|
| GET  | `/api/public/sheets/:sheetId` | シート・時間帯情報取得 |
| POST | `/api/public/sheets/:sheetId/reservations` | 予約作成 |
| POST | `/api/public/reservations/:id/cancel` | 来場者キャンセル |
| GET  | `/api/sheets/:sheetId/call-status` | 呼出モニター用 |
| GET  | `/api/sheets/:sheetId/status` | 統計モニター用 |

### スタッフAPI（Bearer Token必要）
| メソッド | パス | 説明 |
|---------|------|------|
| GET  | `/api/staff/sheets/:sheetId/overview` | 運用画面データ取得 |
| POST | `/api/staff/reservations/:id/accept` | 受付 |
| POST | `/api/staff/queues/:id/mark-absent-and-next` | 不在にして次へ |
| POST | `/api/staff/queues/:id/call-next` | 手動で次を呼出 |
| POST | `/api/staff/queues/:id/recovery` | 救済キュー追加 |
| GET  | `/api/staff/sheets/:id/reservations/search` | 整理番号検索 |
| POST | `/api/staff/reservations/:id/emergency-call` | 即時呼出 |
| POST | `/api/staff/reservations/:id/cancel` | 即時キャンセル |

### 認証
| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/api/auth/login` | ログイン（JWT取得） |
| POST | `/api/auth/logout` | ログアウト |

---

## 自動処理（Cron / 毎分）
- `call_start_at` 到達 → 通常キューの呼出開始
- `call_end_at` 到達 → `expiration_pending` へ移行
- `expire_at` 到達 → `reserved/calling/absent` を `expired` へ

---

## ディレクトリ構成
```
seiriken/
├── api/
│   ├── src/
│   │   ├── index.ts          # エントリポイント
│   │   ├── types.ts          # 型定義
│   │   ├── auth.ts           # JWT・パスワード
│   │   ├── errors.ts         # エラーコード
│   │   ├── middleware.ts     # 認証・権限ミドルウェア
│   │   ├── scheduler.ts      # Cron処理
│   │   ├── db/
│   │   │   ├── migrate.sql   # DBスキーマ
│   │   │   └── queries.ts    # DBクエリ関数
│   │   ├── domain/
│   │   │   ├── timeslot.ts   # 時間帯ロジック
│   │   │   └── queue.ts      # キュー処理
│   │   └── routes/
│   │       ├── auth.ts       # 認証API
│   │       ├── public.ts     # 公開API
│   │       ├── staff.ts      # スタッフAPI
│   │       ├── manage.ts     # 管理API
│   │       ├── display.ts    # 表示用API
│   │       └── scenes.ts     # Scene API
│   ├── wrangler.toml
│   ├── tsconfig.json
│   └── package.json
└── frontend/
    ├── reserve.html          # 予約画面
    ├── staff.html            # スタッフ運用画面
    ├── monitor.html          # 呼出モニター
    ├── stats.html            # 受付状況モニター
    ├── css/style.css
    └── js/api.js             # APIクライアント
```
