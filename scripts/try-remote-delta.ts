/**
 * Проверка применения дельты Dropbox к индексу (src/remote/index.ts).
 * Сеть и диск Dropbox не нужны: база временная, записи дельты — синтетические.
 *
 *   npx tsx scripts/try-remote-delta.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viarde-try-'));
// до импорта: db/index.ts читает путь к базе при загрузке модуля
process.env.VIARDE_DB = path.join(dir, 'try.db');

let failed = 0;
function expect(label: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       получено ${JSON.stringify(actual)}\n       ожидалось ${JSON.stringify(wanted)}`}`);
}

async function main() {
  const { getDb, schema } = await import('../src/db');
  const { applyDelta } = await import('../src/remote');
  type ApiEntry = import('../src/remote').ApiEntry;
  type Result = import('../src/remote').RemoteSyncResult;

  const db = getDb();
  const P = '/Kraus_900_Test_Project';
  const now = new Date();

  db.insert(schema.trackedProjects)
    .values({ key: 'job:900', folderName: 'Kraus_900_Test_Project', addedAt: now, syncedAt: now })
    .run();

  const file = (p: string, size = 500_000): ApiEntry => ({
    '.tag': 'file',
    name: p.split('/').pop()!,
    path_lower: p.toLowerCase(),
    path_display: p,
    size,
    client_modified: '2026-11-01T10:00:00Z',
    server_modified: '2026-11-01T10:00:05Z',
    rev: 'r1',
  });
  const folder = (p: string): ApiEntry => ({
    '.tag': 'folder',
    name: p.split('/').pop()!,
    path_lower: p.toLowerCase(),
    path_display: p,
  });
  const deleted = (p: string): ApiEntry => ({
    '.tag': 'deleted',
    name: p.split('/').pop()!,
    path_lower: p.toLowerCase(),
    path_display: p,
  });

  const fresh = (): Result => ({
    loaded: [], missing: [], touched: [], deltaEntries: 0, deltaIgnored: 0,
    wasReset: false, rateLimited: 0, durationMs: 0,
  });
  const paths = () =>
    db.select({ p: schema.remoteEntries.pathLower }).from(schema.remoteEntries).all().map((r) => r.p).sort();
  const cursor = () =>
    db.select().from(schema.settings).all().find((s) => s.key === 'remote.cursor')?.value ?? null;

  // ── 1. добавление: своё берём, чужое и незначимое отбрасываем
  let r = fresh();
  applyDelta(
    [
      folder(`${P}/04_JPG`),
      folder(`${P}/04_JPG/Scene_1`),
      file(`${P}/04_JPG/Scene_1/A.jpg`),
      folder(`${P}/04_JPG/Scene_10`),
      file(`${P}/04_JPG/Scene_10/B.jpg`),
      folder(`${P}/04_JPG/Scene%1`),
      file(`${P}/04_JPG/Scene%1/C.jpg`),
      file(`${P}/03_Models/big.max`),
      folder(`${P}/03_Models`),
      file('/Kraus_901_Other/04_JPG/S/x.jpg'),
      file('/Aleksey Demchenko/notes.txt'),
    ],
    'c1',
    r,
  );
  expect('добавлены только значимые записи своего проекта', paths(), [
    '/kraus_900_test_project/03_models',
    '/kraus_900_test_project/04_jpg',
    '/kraus_900_test_project/04_jpg/scene%1',
    '/kraus_900_test_project/04_jpg/scene%1/c.jpg',
    '/kraus_900_test_project/04_jpg/scene_1',
    '/kraus_900_test_project/04_jpg/scene_1/a.jpg',
    '/kraus_900_test_project/04_jpg/scene_10',
    '/kraus_900_test_project/04_jpg/scene_10/b.jpg',
  ]);
  expect('чужое и незначимое посчитано как отброшенное', r.deltaIgnored, 3);
  expect('проект отмечен затронутым', r.touched, ['job:900']);
  expect('курсор сохранён', cursor(), 'c1');

  // ── 2. удаление папки убирает вложенное, но не соседей с похожим именем.
  // Scene_1 против Scene_10 и Scene%1: '_' и '%' — шаблоны LIKE, здесь они
  // обязаны работать как обычные символы
  r = fresh();
  applyDelta([deleted(`${P}/04_JPG/Scene_1`)], 'c2', r);
  expect('удалена папка с содержимым, соседи целы', paths(), [
    '/kraus_900_test_project/03_models',
    '/kraus_900_test_project/04_jpg',
    '/kraus_900_test_project/04_jpg/scene%1',
    '/kraus_900_test_project/04_jpg/scene%1/c.jpg',
    '/kraus_900_test_project/04_jpg/scene_10',
    '/kraus_900_test_project/04_jpg/scene_10/b.jpg',
  ]);

  // ── 3. перезапись файла обновляет запись, а не плодит вторую
  r = fresh();
  applyDelta([file(`${P}/04_JPG/Scene_10/B.jpg`, 777_000)], 'c3', r);
  const b = db.select().from(schema.remoteEntries).all().find((e) => e.name === 'B.jpg');
  expect('размер перезаписанного файла обновлён', b?.size, 777_000);
  expect('дата файла сохранена в миллисекундах', b?.clientModified?.getTime(), Date.parse('2026-11-01T10:00:00Z'));

  // ── 4. изменение самой папки проекта — проект целиком на перечитывание
  r = fresh();
  applyDelta([deleted(P), folder('/Kraus_900_Renamed_Project')], 'c4', r);
  const tracked = db.select().from(schema.trackedProjects).all()[0];
  expect('индекс проекта очищен', paths(), []);
  expect('проект помечен на перечитывание', tracked.syncedAt, null);
  expect('новое имя папки относится к тому же проекту', r.deltaIgnored, 0);
  expect('курсор продвинулся', cursor(), 'c4');
}

main()
  .catch((error) => {
    failed++;
    console.error('СБОЙ:', error);
  })
  .finally(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* база ещё открыта — временная папка уйдёт вместе с процессом */
    }
    console.log(failed === 0 ? '\nвсё зелёное' : `\nпровалено: ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  });
