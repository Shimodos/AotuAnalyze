import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Localized } from '@/i18n/types';

/**
 * Схема истории. Текущее состояние считается сканом за ~1 секунду,
 * поэтому БД хранит то, что из одного скана не выводится:
 * переходы стадий, время входа в стадию, пины и ручные оверрайды.
 *
 * Диалект sqlite. Переезд на Postgres — замена импорта на drizzle-orm/pg-core,
 * остальной код не меняется.
 */

export const projects = sqliteTable(
  'projects',
  {
    /** job:211 — переживает переименование названия проекта */
    key: text('key').primaryKey(),
    folderName: text('folder_name').notNull(),
    path: text('path').notNull(),
    jobNumber: integer('job_number'),
    title: text('title').notNull(),

    column: text('column').notNull(),
    ball: text('ball').notNull(),
    deliveryKind: text('delivery_kind'),
    round: integer('round'),
    maxRound: integer('max_round'),
    /** код перевода основания стадии; подстановки — в evidence_params */
    evidence: text('evidence').notNull(),
    evidenceParams: text('evidence_params', { mode: 'json' }).$type<Record<string, string | number>>(),

    /** момент входа в текущую колонку — считается по истории, а не по mtime */
    stageSince: integer('stage_since', { mode: 'timestamp_ms' }),
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }),
    lastDeliveryAt: integer('last_delivery_at', { mode: 'timestamp_ms' }),
    lastRenderAt: integer('last_render_at', { mode: 'timestamp_ms' }),

    scenesTotal: integer('scenes_total').notNull().default(0),
    scenesRendered: integer('scenes_rendered').notNull().default(0),
    /** сырых EXR по проекту — ферма считает */
    exrTotal: integer('exr_total').notNull().default(0),
    lastExrAt: integer('last_exr_at', { mode: 'timestamp_ms' }),
    /** ферма пишет EXR свежее всего — рендер идёт параллельно с любым этапом */
    farmActive: integer('farm_active', { mode: 'boolean' }).notNull().default(false),
    psdTotal: integer('psd_total').notNull().default(0),
    lastPsdAt: integer('last_psd_at', { mode: 'timestamp_ms' }),
    /** разбивка сцен по этапам: проект бывает в нескольких сразу */
    scenesRendering: integer('scenes_rendering').notNull().default(0),
    scenesConverted: integer('scenes_converted').notNull().default(0),
    scenesPost: integer('scenes_post').notNull().default(0),

    isSettling: integer('is_settling', { mode: 'boolean' }).notNull().default(false),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    hasClientFeedback: integer('has_client_feedback', { mode: 'boolean' }).notNull().default(false),
    hasStandardStructure: integer('has_standard_structure', { mode: 'boolean' })
      .notNull()
      .default(true),

    /** ручная фиксация: колонка задана человеком и скан её не двигает */
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    pinnedColumn: text('pinned_column'),
    /** момент закрепления — от него считаются дни и по нему снимается пин */
    pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }),

    coverPath: text('cover_path'),
    missingFolders: text('missing_folders', { mode: 'json' }).$type<string[]>(),
    anomalies: text('anomalies', { mode: 'json' }).$type<Localized[]>(),
    sizeBytes: integer('size_bytes'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('projects_column_idx').on(t.column)],
);

export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    name: text('name').notNull(),
    skus: text('skus', { mode: 'json' }).$type<string[]>(),
    sceneNumber: text('scene_number'),
    isService: integer('is_service', { mode: 'boolean' }).notNull().default(false),
    imageCount: integer('image_count').notNull().default(0),
    /** сырые EXR — признак того, что рендер идёт прямо сейчас */
    exrCount: integer('exr_count').notNull().default(0),
    lastExrAt: integer('last_exr_at', { mode: 'timestamp_ms' }),
    psdCount: integer('psd_count').notNull().default(0),
    lastPsdAt: integer('last_psd_at', { mode: 'timestamp_ms' }),
    psdFolder: text('psd_folder'),
    phase: text('phase').notNull().default('EMPTY'),
    versions: text('versions', { mode: 'json' }).$type<Array<{ name: string; imageCount: number }>>(),
    maxVersion: text('max_version'),
    lastImageAt: integer('last_image_at', { mode: 'timestamp_ms' }),
    coverPath: text('cover_path'),
    hasUnrecognizedFiles: integer('has_unrecognized_files', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (t) => [index('scenes_project_idx').on(t.projectKey)],
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    folderName: text('folder_name').notNull(),
    kind: text('kind'),
    round: integer('round'),
    isJunk: integer('is_junk', { mode: 'boolean' }).notNull().default(false),
    fileCount: integer('file_count').notNull().default(0),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('deliveries_project_idx').on(t.projectKey)],
);

/** Аудит всех переходов — из него считается «сколько дней в стадии» */
export const stageEvents = sqliteTable(
  'stage_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectKey: text('project_key').notNull(),
    fromColumn: text('from_column'),
    toColumn: text('to_column').notNull(),
    reason: text('reason').notNull(),
    evidence: text('evidence'),
    evidenceParams: text('evidence_params', { mode: 'json' }).$type<Record<string, string | number>>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('stage_events_project_idx').on(t.projectKey)],
);

export const scanRuns = sqliteTable('scan_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  projectCount: integer('project_count'),
  transitionCount: integer('transition_count'),
  durationMs: integer('duration_ms'),
  withSizes: integer('with_sizes', { mode: 'boolean' }).notNull().default(false),
  error: text('error'),
});

export type ProjectRow = typeof projects.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type StageEventRow = typeof stageEvents.$inferSelect;

/**
 * Журнал изменений внутри проекта: что появилось, выросло или переписано.
 * Считается сравнением снапшота сцен и отгрузок с предыдущим сканом,
 * поэтому не стоит ни одного лишнего обращения к диску.
 */
export const changes = sqliteTable(
  'changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectKey: text('project_key').notNull(),
    /** SCENE или DELIVERY — где произошло */
    area: text('area').notNull(),
    /** имя папки */
    target: text('target').notNull(),
    /** код перевода: change.imagesAdded и т.п. */
    kind: text('kind').notNull(),
    params: text('params', { mode: 'json' }).$type<Record<string, string | number>>(),
    /** сколько раз это же изменение повторилось, пока его не просмотрели */
    times: integer('times').notNull().default(1),
    /** дата самого свежего файла, вызвавшего изменение */
    fileAt: integer('file_at', { mode: 'timestamp_ms' }),
    detectedAt: integer('detected_at', { mode: 'timestamp_ms' }).notNull(),
    isSeen: integer('is_seen', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('changes_project_idx').on(t.projectKey)],
);

/** Пары ключ-значение: токены Dropbox и прочие настройки подключения */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
