-- ============================================================
-- 整理券システム D1 マイグレーション v1
-- DB設計 v2.5 準拠
-- ============================================================

-- projects
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT,
  status      TEXT    NOT NULL DEFAULT 'draft'
                      CHECK(status IN ('draft','active','suspended','archived')),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- sheets
CREATE TABLE IF NOT EXISTS sheets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  name                TEXT    NOT NULL,
  ticket_prefix       TEXT    NOT NULL,
  ticket_digits       INTEGER NOT NULL DEFAULT 4,
  ticket_next_number  INTEGER NOT NULL DEFAULT 1,
  entry_enabled       INTEGER NOT NULL DEFAULT 0 CHECK(entry_enabled IN (0,1)),
  status              TEXT    NOT NULL DEFAULT 'active',
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE(project_id, name),
  UNIQUE(project_id, ticket_prefix)
);

-- time_slots
CREATE TABLE IF NOT EXISTS time_slots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id         INTEGER NOT NULL REFERENCES sheets(id),
  name             TEXT    NOT NULL,
  start_at         TEXT    NOT NULL,
  end_at           TEXT    NOT NULL,
  capacity_groups  INTEGER NOT NULL CHECK(capacity_groups >= 1),
  call_start_at    TEXT    NOT NULL,
  call_end_at      TEXT    NOT NULL,
  expire_at        TEXT    NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'active',
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  CHECK(start_at < end_at),
  CHECK(call_start_at <= call_end_at),
  CHECK(call_end_at <= expire_at)
);

-- reservations
CREATE TABLE IF NOT EXISTS reservations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id          INTEGER NOT NULL REFERENCES sheets(id),
  time_slot_id      INTEGER NOT NULL REFERENCES time_slots(id),
  ticket_number     INTEGER NOT NULL,
  ticket_code       TEXT    NOT NULL,
  group_size        INTEGER NOT NULL CHECK(group_size >= 1),
  status            TEXT    NOT NULL DEFAULT 'reserved'
                            CHECK(status IN (
                              'reserved','calling','absent',
                              'accepted','entered','cancelled','expired'
                            )),
  reserved_at       TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  cancelled_at      TEXT,
  cancel_token_hash TEXT,
  UNIQUE(sheet_id, ticket_number),
  UNIQUE(sheet_id, ticket_code),
  UNIQUE(cancel_token_hash)
);

-- call_queues
CREATE TABLE IF NOT EXISTS call_queues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  time_slot_id     INTEGER NOT NULL REFERENCES time_slots(id),
  status           TEXT    NOT NULL DEFAULT 'waiting'
                           CHECK(status IN (
                             'waiting','calling','expiration_pending',
                             'recovery_calling','finished','expired'
                           )),
  current_entry_id INTEGER,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE(time_slot_id)
);

-- call_queue_entries
CREATE TABLE IF NOT EXISTS call_queue_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id       INTEGER NOT NULL REFERENCES call_queues(id),
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  queue_type     TEXT    NOT NULL CHECK(queue_type IN ('normal','recovery')),
  queue_seq      INTEGER,
  recovery_seq   INTEGER,
  status         TEXT    NOT NULL DEFAULT 'waiting'
                         CHECK(status IN (
                           'waiting','calling','absent',
                           'completed','cancelled','expired'
                         )),
  called_at      TEXT,
  completed_at   TEXT,
  updated_at     TEXT    NOT NULL
);

-- users
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  account_type  TEXT    NOT NULL DEFAULT 'personal'
                        CHECK(account_type IN ('personal','shared')),
  display_name  TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user'
                        CHECK(role IN ('developer','system_admin','user')),
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- user_sheet_permissions
CREATE TABLE IF NOT EXISTS user_sheet_permissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  sheet_id   INTEGER NOT NULL REFERENCES sheets(id),
  permission TEXT    NOT NULL
                     CHECK(permission IN ('project_manager','sheet_manager','staff','viewer')),
  created_at TEXT    NOT NULL,
  UNIQUE(user_id, sheet_id)
);

-- user_project_permissions
CREATE TABLE IF NOT EXISTS user_project_permissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  permission TEXT    NOT NULL
                     CHECK(permission IN ('project_manager','viewer')),
  created_at TEXT    NOT NULL,
  UNIQUE(user_id, project_id)
);

-- sheet_notices
CREATE TABLE IF NOT EXISTS sheet_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id    INTEGER NOT NULL REFERENCES sheets(id),
  screen_type TEXT    NOT NULL,
  title       TEXT,
  body        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','inactive')),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- display_configs
CREATE TABLE IF NOT EXISTS display_configs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  name             TEXT    NOT NULL,
  display_key      TEXT    NOT NULL,
  display_slot     INTEGER NOT NULL CHECK(display_slot IN (1,2)),
  display_type     TEXT    NOT NULL DEFAULT 'monitor',
  current_scene_id INTEGER REFERENCES scenes(id),
  status           TEXT    NOT NULL DEFAULT 'active',
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE(project_id, display_slot)
);

-- scenes
CREATE TABLE IF NOT EXISTS scenes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id    INTEGER NOT NULL REFERENCES sheets(id),
  name        TEXT    NOT NULL,
  description TEXT,
  status      TEXT    NOT NULL DEFAULT 'active',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

-- scene_items
CREATE TABLE IF NOT EXISTS scene_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id    INTEGER NOT NULL REFERENCES scenes(id),
  item_type   TEXT    NOT NULL
                      CHECK(item_type IN ('display','text','shape','placeholder','qr')),
  asset_id    INTEGER,
  data_source TEXT,
  x           REAL    NOT NULL DEFAULT 0,
  y           REAL    NOT NULL DEFAULT 0,
  width       REAL    NOT NULL DEFAULT 100,
  height      REAL    NOT NULL DEFAULT 100,
  z_index     INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- assets
CREATE TABLE IF NOT EXISTS assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK(type IN ('image','video','other')),
  storage_key TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  file_size   INTEGER,
  status      TEXT    NOT NULL DEFAULT 'active',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type   TEXT    NOT NULL,
  user_id      INTEGER,
  sheet_id     INTEGER,
  action       TEXT    NOT NULL,
  target_type  TEXT,
  target_id    INTEGER,
  details_json TEXT,
  created_at   TEXT    NOT NULL
);

-- ============================================================
-- インデックス
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sheets_project        ON sheets(project_id);
CREATE INDEX IF NOT EXISTS idx_timeslots_sheet        ON time_slots(sheet_id);
CREATE INDEX IF NOT EXISTS idx_timeslots_sheet_start  ON time_slots(sheet_id, start_at);
CREATE INDEX IF NOT EXISTS idx_reservations_sheet     ON reservations(sheet_id);
CREATE INDEX IF NOT EXISTS idx_reservations_timeslot  ON reservations(time_slot_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status    ON reservations(sheet_id, status);
CREATE INDEX IF NOT EXISTS idx_queues_timeslot        ON call_queues(time_slot_id);
CREATE INDEX IF NOT EXISTS idx_entries_queue          ON call_queue_entries(queue_id);
CREATE INDEX IF NOT EXISTS idx_entries_queue_seq      ON call_queue_entries(queue_id, queue_seq);
CREATE INDEX IF NOT EXISTS idx_entries_queue_status   ON call_queue_entries(queue_id, status);
CREATE INDEX IF NOT EXISTS idx_usp_user               ON user_sheet_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_usp_sheet              ON user_sheet_permissions(sheet_id);
CREATE INDEX IF NOT EXISTS idx_upp_user               ON user_project_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_auditlog_sheet         ON audit_logs(sheet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scenes_sheet           ON scenes(sheet_id);
