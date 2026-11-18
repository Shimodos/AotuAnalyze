import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { dataDir } from '@/server/dataDir';
import * as schema from './schema';

const DB_PATH = process.env.VIARDE_DB ?? path.join(dataDir(), 'data', 'tracker.db');

/**
 * DDL держим здесь, а не в drizzle-kit: одна таблица правды, применяется идемпотентно
 * при любом старте (dev-сервер, CLI-скан, прод). Никаких интерактивных шагов.
 * Схема обязана совпадать со schema.ts.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  key TEXT PRIMARY KEY,
  folder_name TEXT NOT NULL,
  path TEXT NOT NULL,
  job_number INTEGER,
  title TEXT NOT NULL,
  "column" TEXT NOT NULL,
  ball TEXT NOT NULL,
  delivery_kind TEXT,
  round INTEGER,
  max_round INTEGER,
  evidence TEXT NOT NULL,
  evidence_params TEXT,
  stage_since INTEGER,
  last_activity_at INTEGER,
  last_delivery_at INTEGER,
  last_render_at INTEGER,
  scenes_total INTEGER NOT NULL DEFAULT 0,
  scenes_rendered INTEGER NOT NULL DEFAULT 0,
  exr_total INTEGER NOT NULL DEFAULT 0,
  last_exr_at INTEGER,
  farm_active INTEGER NOT NULL DEFAULT 0,
  psd_total INTEGER NOT NULL DEFAULT 0,
  last_psd_at INTEGER,
  scenes_rendering INTEGER NOT NULL DEFAULT 0,
  scenes_converted INTEGER NOT NULL DEFAULT 0,
  scenes_post INTEGER NOT NULL DEFAULT 0,
  planned_total INTEGER NOT NULL DEFAULT 0,
  planned_done INTEGER NOT NULL DEFAULT 0,
  is_settling INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  has_client_feedback INTEGER NOT NULL DEFAULT 0,
  has_standard_structure INTEGER NOT NULL DEFAULT 1,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_column TEXT,
  pinned_at INTEGER,
  cover_path TEXT,
  cover_at INTEGER,
  missing_folders TEXT,
  anomalies TEXT,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS projects_column_idx ON projects("column");

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  name TEXT NOT NULL,
  skus TEXT,
  scene_number TEXT,
  is_service INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  exr_count INTEGER NOT NULL DEFAULT 0,
  last_exr_at INTEGER,
  psd_count INTEGER NOT NULL DEFAULT 0,
  last_psd_at INTEGER,
  psd_folder TEXT,
  psd_stages TEXT,
  phase TEXT NOT NULL DEFAULT 'EMPTY',
  planned_total INTEGER NOT NULL DEFAULT 0,
  planned_matched INTEGER NOT NULL DEFAULT 0,
  planned_missing TEXT,
  planned_groups TEXT,
  versions TEXT,
  last_image_at INTEGER,
  cover_path TEXT,
  has_unrecognized_files INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS scenes_project_idx ON scenes(project_key);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  kind TEXT,
  round INTEGER,
  is_junk INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS deliveries_project_idx ON deliveries(project_key);

CREATE TABLE IF NOT EXISTS stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  from_column TEXT,
  to_column TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  evidence_params TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stage_events_project_idx ON stage_events(project_key);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  area TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  params TEXT,
  times INTEGER NOT NULL DEFAULT 1,
  file_at INTEGER,
  detected_at INTEGER NOT NULL,
  is_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS changes_project_idx ON changes(project_key);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  project_count INTEGER,
  transition_count INTEGER,
  duration_ms INTEGER,
  with_sizes INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

-- Отметки «правки по кадру внесены».
-- ОТДЕЛЬНАЯ таблица, а не колонка в scenes: sync.ts при каждом скане делает
-- delete(scenes) и вставляет заново, отметки исчезали бы каждые 15 минут.
-- Список кадров здесь не хранится — он читается с диска в момент открытия,
-- поэтому всегда актуален. Здесь только то, что проставил человек.
CREATE TABLE IF NOT EXISTS scene_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  scene_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  is_done INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS scene_checks_uniq
  ON scene_checks(project_key, scene_name, file_name, round);
CREATE INDEX IF NOT EXISTS scene_checks_scene_idx
  ON scene_checks(project_key, scene_name);

-- Кеш дорогих результатов обхода диска между сканами: разобранные xlsx-планы
-- и сводки папок отгрузок. Скан идёт отдельным процессом, поэтому кеш в
-- памяти не переживает его, а на USB-диске повторный разбор стоит секунды.
-- stamp — отпечаток источника (mtime/размер); не совпал — запись протухла.
CREATE TABLE IF NOT EXISTS file_cache (
  key TEXT PRIMARY KEY,
  stamp TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Проекты, за которыми трекер следит через Dropbox API (docs/PLAN-DROPBOX-API.md).
-- Через API в корне видно в разы больше папок, чем синхронизировано на диск,
-- поэтому список явный. synced_at IS NULL — дерево проекта ещё не загружено
-- (или его нужно перечитать): загрузка идёт по проектам и переживает обрыв.
CREATE TABLE IF NOT EXISTS tracked_projects (
  key TEXT PRIMARY KEY,
  folder_name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  synced_at INTEGER
);

-- Индекс дерева отслеживаемых проектов: то, что сканер раньше узнавал
-- обходом диска. Только значимые для стадий папки, см. remote/index.ts.
CREATE TABLE IF NOT EXISTS remote_entries (
  path_lower TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  path_display TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  client_modified INTEGER,
  server_modified INTEGER,
  rev TEXT
);
CREATE INDEX IF NOT EXISTS remote_entries_project_idx ON remote_entries(project_key);
`;

function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // К одному файлу обращаются несколько писателей: сервер со своим фоновым
  // сканом и CLI `npm run scan`. Без busy_timeout better-sqlite3 бросает
  // SQLITE_BUSY сразу же, и запрос падает пятисоткой. Пусть ждёт своей очереди.
  sqlite.pragma('busy_timeout = 10000');
  sqlite.exec(DDL);

  // CREATE TABLE IF NOT EXISTS не добавляет колонки в уже созданную таблицу,
  // поэтому новые поля доносим отдельно и идемпотентно.
  addColumnIfMissing(sqlite, 'projects', 'pinned_at', 'INTEGER');
  addColumnIfMissing(sqlite, 'projects', 'evidence_params', 'TEXT');
  addColumnIfMissing(sqlite, 'stage_events', 'evidence_params', 'TEXT');
  addColumnIfMissing(sqlite, 'scenes', 'exr_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'scenes', 'last_exr_at', 'INTEGER');
  addColumnIfMissing(sqlite, 'changes', 'times', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(sqlite, 'projects', 'exr_total', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'last_exr_at', 'INTEGER');
  addColumnIfMissing(sqlite, 'projects', 'farm_active', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'psd_total', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'last_psd_at', 'INTEGER');
  addColumnIfMissing(sqlite, 'projects', 'scenes_rendering', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'scenes_converted', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'scenes_post', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'scenes', 'psd_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'scenes', 'last_psd_at', 'INTEGER');
  addColumnIfMissing(sqlite, 'scenes', 'psd_folder', 'TEXT');
  addColumnIfMissing(sqlite, 'scenes', 'psd_stages', 'TEXT');
  addColumnIfMissing(sqlite, 'scenes', 'phase', "TEXT NOT NULL DEFAULT 'EMPTY'");
  addColumnIfMissing(sqlite, 'projects', 'planned_total', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'planned_done', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'scenes', 'planned_total', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'scenes', 'planned_matched', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'scenes', 'planned_missing', 'TEXT');
  addColumnIfMissing(sqlite, 'scenes', 'planned_groups', 'TEXT');
  addColumnIfMissing(sqlite, 'projects', 'cover_at', 'INTEGER');

  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };
