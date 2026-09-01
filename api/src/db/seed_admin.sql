-- 初期管理者ユーザー作成
-- パスワード: admin1234（本番運用前に必ず変更すること）
INSERT INTO users (username, password_hash, account_type, display_name, role, status, created_at, updated_at)
VALUES (
  'admin',
  'pbkdf2:32165584e4d8f08489b56418517bd80e:21422ac7cc8b5e3fc660c719eb1c48f2bb821b8365e6f1f3c759b826f29f5ab4',
  'personal',
  '管理者',
  'system_admin',
  'active',
  datetime('now'),
  datetime('now')
);
