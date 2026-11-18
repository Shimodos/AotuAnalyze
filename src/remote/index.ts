/**
 * Индекс дерева проектов из Dropbox API — замена обходу диска
 * (docs/PLAN-DROPBOX-API.md, этап 1).
 *
 * Диск здесь не трогается вообще: ни readdir, ни stat. Всё, что сканер
 * узнавал обходом папки, приходит из API и складывается в remote_entries.
 *
 * Как устроена синхронизация:
 *   1. Курсор корня берём через get_latest_cursor — без листинга. Листать
 *      весь корень нельзя: в командном пространстве больше 640 тыс. записей,
 *      за 15 минут он не дочитывается (замер этапа 0).
 *   2. Дерево читаем по проектам, только отслеживаемые (tracked_projects):
 *      проект — это 1–4 секунды. Курсор взят ДО чтения, поэтому изменение,
 *      случившееся во время загрузки, придёт дельтой и не потеряется.
 *   3. Дальше — дельта по курсору корня. Она несёт изменения по всему
 *      пространству; чужие проекты отбрасываем по пути.
 */

import { and, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { CONFIG } from '@/config';
import { getDb, schema } from '@/db';
import { dropboxCall } from '@/dropbox/client';
import { readSetting, writeSetting } from '@/dropbox/tokens';
import { projectKey } from '@/scanner/parse';

const CURSOR_KEY = 'remote.cursor';

/**
 * Папки проекта, содержимое которых влияет на стадию. Остальное (модели,
 * текстуры, референсы) — это тысячи файлов, которые сканер никогда не читал.
 */
const DEEP_FOLDERS = new Set(['01_clients', '04_jpg', '04_exr', '04_psd', '05_outbox']);

/** Запись листинга Dropbox: файл, папка или отметка об удалении */
export interface ApiEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  name: string;
  /** бывает пустым у записей, до которых нет доступа по пути */
  path_lower?: string;
  path_display?: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
}

interface ListResult {
  entries: ApiEntry[];
  cursor: string;
  has_more: boolean;
}

export interface RemoteSyncResult {
  /** проекты, дерево которых загружено целиком за этот запуск */
  loaded: string[];
  /** отслеживаемые проекты, папки которых в корне Dropbox нет */
  missing: string[];
  /** проекты, в которых дельта что-то изменила — их и нужно пересчитать */
  touched: string[];
  deltaEntries: number;
  /** записи дельты, не относящиеся к отслеживаемым проектам */
  deltaIgnored: number;
  /** курсор протух и индекс пришлось перечитать */
  wasReset: boolean;
  rateLimited: number;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Лимиты Dropbox не публикует — при 429 просто ждём и повторяем */
async function call<T>(route: string, body: unknown, stats: { rateLimited: number }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await dropboxCall<T>(route, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('HTTP 429') || attempt >= 5) throw error;
      stats.rateLimited++;
      await sleep(10_000);
    }
  }
}

function isCursorReset(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('HTTP 409') && message.includes('reset');
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('HTTP 409') && message.includes('not_found');
}

/** Сегменты пути без ведущего слэша: «/a/b» → ['a', 'b'] */
function segments(p: string): string[] {
  return p.split('/').filter(Boolean);
}

/**
 * Нужна ли запись индексу. rel — путь внутри проекта в нижнем регистре.
 * Саму папку проекта и её первый уровень держим всегда (по ним считается
 * «стандартная структура»), глубже — только значимые папки.
 */
function isRelevant(rel: string[]): boolean {
  return rel.length <= 1 || DEEP_FOLDERS.has(rel[0]);
}

type Row = typeof schema.remoteEntries.$inferInsert;

function toRow(entry: ApiEntry, key: string): Row | null {
  if (!entry.path_lower || !entry.path_display || entry['.tag'] === 'deleted') return null;
  const time = (value?: string) => (value ? new Date(value) : null);
  return {
    pathLower: entry.path_lower,
    projectKey: key,
    pathDisplay: entry.path_display,
    name: entry.name,
    isDir: entry['.tag'] === 'folder',
    size: entry.size ?? null,
    clientModified: time(entry.client_modified),
    serverModified: time(entry.server_modified),
    rev: entry.rev ?? null,
  };
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

function upsertRows(tx: Tx, rows: Row[]) {
  for (const row of rows) {
    tx.insert(schema.remoteEntries)
      .values(row)
      .onConflictDoUpdate({ target: schema.remoteEntries.pathLower, set: row })
      .run();
  }
}

/** Удалить запись и всё, что под ней: об удалении папки API сообщает одной записью */
function deleteSubtree(tx: Tx, pathLower: string) {
  // Вложенное — это диапазон строк от «путь/» до «путь0» ('0' — следующий
  // символ после '/'). Не LIKE: в именах папок встречаются '_' и '%',
  // а для LIKE это шаблоны.
  tx.delete(schema.remoteEntries)
    .where(
      or(
        eq(schema.remoteEntries.pathLower, pathLower),
        and(
          gte(schema.remoteEntries.pathLower, pathLower + '/'),
          lt(schema.remoteEntries.pathLower, pathLower + '0'),
        ),
      ),
    )
    .run();
}

/** Папки проектов в корне: ключ проекта → текущее имя папки. Один нерекурсивный запрос. */
export async function listRootProjects(
  stats: { rateLimited: number } = { rateLimited: 0 },
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let page = await call<ListResult>('files/list_folder', { path: '', limit: 2000 }, stats);
  for (;;) {
    for (const e of page.entries) {
      // те же правила, что у listProjectFolders в scanner/scan.ts
      if (e['.tag'] !== 'folder' || !/^Kraus[_\s]/i.test(e.name)) continue;
      if ((CONFIG.notProjects as readonly string[]).includes(e.name)) continue;
      found.set(projectKey(e.name), e.name);
    }
    if (!page.has_more) break;
    page = await call<ListResult>('files/list_folder/continue', { cursor: page.cursor }, stats);
  }
  return found;
}

/**
 * Первое наполнение списка: проекты, которые трекер уже знает. Так история
 * переходов, пины и чеклисты остаются привязанными к карточкам.
 */
export function seedTrackedFromProjects(): number {
  const db = getDb();
  if (db.select({ key: schema.trackedProjects.key }).from(schema.trackedProjects).limit(1).get()) return 0;

  const known = db
    .select({ key: schema.projects.key, folderName: schema.projects.folderName })
    .from(schema.projects)
    .all();
  if (known.length === 0) return 0;

  const now = new Date();
  db.insert(schema.trackedProjects)
    .values(known.map((p) => ({ key: p.key, folderName: p.folderName, addedAt: now, syncedAt: null })))
    .run();
  return known.length;
}

/** Загрузить дерево одного проекта целиком и заменить им то, что было в индексе */
async function loadProject(
  key: string,
  folderName: string,
  stats: { rateLimited: number },
): Promise<void> {
  const rows: Row[] = [];
  const root = '/' + folderName;

  let page = await call<ListResult>('files/list_folder', { path: root, recursive: true, limit: 2000 }, stats);
  for (;;) {
    for (const e of page.entries) {
      if (!e.path_lower) continue;
      if (!isRelevant(segments(e.path_lower).slice(1))) continue;
      const row = toRow(e, key);
      if (row) rows.push(row);
    }
    if (!page.has_more) break;
    page = await call<ListResult>('files/list_folder/continue', { cursor: page.cursor }, stats);
  }

  // Замена одной транзакцией: либо проект в индексе целиком, либо его старая версия
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(schema.remoteEntries).where(eq(schema.remoteEntries.projectKey, key)).run();
    upsertRows(tx, rows);
    tx.update(schema.trackedProjects)
      .set({ folderName, syncedAt: new Date() })
      .where(eq(schema.trackedProjects.key, key))
      .run();
  });
}

/** Загрузить все проекты, у которых дерево ещё не прочитано */
async function loadPending(result: RemoteSyncResult): Promise<void> {
  const db = getDb();
  const pending = db
    .select()
    .from(schema.trackedProjects)
    .where(isNull(schema.trackedProjects.syncedAt))
    .all();
  if (pending.length === 0) return;

  // Папку могли переименовать — имя берём из корня по ключу, а не из базы
  const inRoot = await listRootProjects(result);

  for (const project of pending) {
    const folderName = inRoot.get(project.key);
    if (!folderName) {
      if (!result.missing.includes(project.key)) result.missing.push(project.key);
      continue;
    }
    try {
      await loadProject(project.key, folderName, result);
      if (!result.loaded.includes(project.key)) result.loaded.push(project.key);
    } catch (error) {
      // Папка исчезла между листингом корня и чтением — не повод ронять остальных
      if (!isNotFound(error)) throw error;
      if (!result.missing.includes(project.key)) result.missing.push(project.key);
    }
  }
}

/**
 * Применить одну страницу дельты и сохранить курсор. Затронутые проекты
 * попадают в result.touched. Экспортируется ради scripts/try-remote-delta.ts.
 */
export function applyDelta(entries: ApiEntry[], cursor: string, result: RemoteSyncResult) {
  const db = getDb();
  const tracked = new Set(
    db.select({ key: schema.trackedProjects.key }).from(schema.trackedProjects).all().map((r) => r.key),
  );

  db.transaction((tx) => {
    for (const e of entries) {
      result.deltaEntries++;
      if (!e.path_lower || !e.path_display) {
        result.deltaIgnored++;
        continue;
      }

      const display = segments(e.path_display);
      const key = display.length > 0 ? projectKey(display[0]) : '';
      if (!tracked.has(key)) {
        result.deltaIgnored++;
        continue;
      }

      const rel = segments(e.path_lower).slice(1);

      // Изменение самой папки проекта (переименовали, удалили, вернули) —
      // не разбираем по частям, а перечитываем проект целиком
      if (rel.length === 0) {
        tx.delete(schema.remoteEntries).where(eq(schema.remoteEntries.projectKey, key)).run();
        tx.update(schema.trackedProjects)
          .set({ syncedAt: null })
          .where(eq(schema.trackedProjects.key, key))
          .run();
        if (!result.touched.includes(key)) result.touched.push(key);
        continue;
      }

      if (!isRelevant(rel)) {
        result.deltaIgnored++;
        continue;
      }

      // По правилам Dropbox: что бы ни пришло, сначала убираем то, что было по
      // этому пути. Для удаления и для замены файла папкой — вместе с вложенным.
      if (e['.tag'] === 'deleted' || e['.tag'] === 'file') deleteSubtree(tx, e.path_lower);
      const row = toRow(e, key);
      if (row) upsertRows(tx, [row]);
      if (!result.touched.includes(key)) result.touched.push(key);
    }

    // Курсор сохраняем той же транзакцией, что и страницу: после обрыва
    // продолжим ровно с того места, ничего не применив дважды и не пропустив
    const values = { key: CURSOR_KEY, value: cursor, updatedAt: new Date() };
    tx.insert(schema.settings)
      .values(values)
      .onConflictDoUpdate({ target: schema.settings.key, set: values })
      .run();
  });
}

async function runDelta(result: RemoteSyncResult): Promise<void> {
  let cursor: string | null = readSetting(CURSOR_KEY);
  if (!cursor) return;
  for (;;) {
    const page: ListResult = await call<ListResult>('files/list_folder/continue', { cursor }, result);
    applyDelta(page.entries, page.cursor, result);
    cursor = page.cursor;
    if (!page.has_more) break;
  }
}

/** Сбросить индекс: курсор протух, состояние придётся перечитать */
function resetIndex() {
  const db = getDb();
  writeSetting(CURSOR_KEY, null);
  db.update(schema.trackedProjects).set({ syncedAt: null }).run();
}

/**
 * Один проход синхронизации индекса. Безопасно запускать повторно и после
 * обрыва: загруженные проекты заново не читаются, дельта продолжается с курсора.
 */
export async function syncRemote(): Promise<RemoteSyncResult> {
  const started = Date.now();
  const result: RemoteSyncResult = {
    loaded: [],
    missing: [],
    touched: [],
    deltaEntries: 0,
    deltaIgnored: 0,
    wasReset: false,
    rateLimited: 0,
    durationMs: 0,
  };

  seedTrackedFromProjects();

  for (let attempt = 0; ; attempt++) {
    try {
      // Курсор — до загрузки проектов, см. шапку файла
      if (!readSetting(CURSOR_KEY)) {
        const latest = await call<{ cursor: string }>(
          'files/list_folder/get_latest_cursor',
          { path: '', recursive: true },
          result,
        );
        writeSetting(CURSOR_KEY, latest.cursor);
      }

      await loadPending(result);
      await runDelta(result);
      // дельта могла пометить проект на перечитывание (переименование папки)
      await loadPending(result);
      break;
    } catch (error) {
      if (!isCursorReset(error) || attempt >= 1) throw error;
      result.wasReset = true;
      resetIndex();
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}

/**
 * Синхронизация из процесса сервера, без ожидания: экран настроек добавляет
 * проект и сразу отвечает, а дерево подтягивается следом. В отличие от обхода
 * диска, здесь всё время уходит на сеть, так что сервер не блокируется.
 * Второй запуск поверх идущего не нужен — идущий сам подберёт всё, что ждёт.
 */
let running: Promise<RemoteSyncResult> | null = null;

export function isRemoteSyncRunning(): boolean {
  return running !== null;
}

/**
 * Синхронизация с общим для процесса замком: если она уже идёт (её запустил
 * экран настроек или наблюдатель), ждём её и следом запускаем свою — идущая
 * могла начаться до изменения, ради которого нас позвали.
 */
export async function syncRemoteShared(): Promise<RemoteSyncResult> {
  if (running) await running.catch(() => undefined);
  if (running) return running;
  const mine = syncRemote();
  running = mine;
  try {
    return await mine;
  } finally {
    if (running === mine) running = null;
  }
}

export function syncRemoteInBackground(): void {
  if (running) return;
  syncRemoteShared().catch((error) => {
    console.error('[tracker] синхронизация индекса не удалась:', error instanceof Error ? error.message : error);
  });
}

/**
 * Содержимое одной папки отслеживаемого проекта из индекса — точечным
 * запросом, без загрузки всего индекса в память.
 *
 * null — проект не отслеживается или его дерево ещё не загружено: индекс про
 * эту папку ничего не знает, и вызывающий вправе спросить диск. Пустой
 * массив — проект в индексе есть, а папки (или файлов в ней) нет.
 */
export function indexDir(
  projectKeyValue: string,
  dropboxDir: string,
): Array<{ name: string; isDir: boolean; size: number }> | null {
  const db = getDb();
  const tracked = db
    .select({ syncedAt: schema.trackedProjects.syncedAt })
    .from(schema.trackedProjects)
    .where(eq(schema.trackedProjects.key, projectKeyValue))
    .get();
  if (!tracked?.syncedAt) return null;

  const dir = dropboxDir.toLowerCase();
  return db
    .select({
      pathLower: schema.remoteEntries.pathLower,
      name: schema.remoteEntries.name,
      isDir: schema.remoteEntries.isDir,
      size: schema.remoteEntries.size,
    })
    .from(schema.remoteEntries)
    .where(and(gte(schema.remoteEntries.pathLower, dir + '/'), lt(schema.remoteEntries.pathLower, dir + '0')))
    .all()
    // диапазон захватывает и вложенное глубже — оставляем прямых потомков
    .filter((row) => !row.pathLower.slice(dir.length + 1).includes('/'))
    .map((row) => ({ name: row.name, isDir: row.isDir, size: row.size ?? 0 }));
}

/** Сводка индекса по проектам — для CLI и экрана настроек */
export function indexSummary(): Array<{ key: string; folderName: string; synced: boolean; files: number; dirs: number }> {
  const db = getDb();
  const tracked = db.select().from(schema.trackedProjects).all();
  if (tracked.length === 0) return [];

  const counts = new Map<string, { files: number; dirs: number }>();
  for (const row of db
    .select({ key: schema.remoteEntries.projectKey, isDir: schema.remoteEntries.isDir })
    .from(schema.remoteEntries)
    .where(inArray(schema.remoteEntries.projectKey, tracked.map((t) => t.key)))
    .all()) {
    const c = counts.get(row.key) ?? { files: 0, dirs: 0 };
    if (row.isDir) c.dirs++;
    else c.files++;
    counts.set(row.key, c);
  }

  return tracked
    .map((t) => ({
      key: t.key,
      folderName: t.folderName,
      synced: t.syncedAt !== null,
      files: counts.get(t.key)?.files ?? 0,
      dirs: counts.get(t.key)?.dirs ?? 0,
    }))
    .sort((a, b) => a.folderName.localeCompare(b.folderName));
}
