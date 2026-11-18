/**
 * Синхронизация индекса проектов из Dropbox API (docs/PLAN-DROPBOX-API.md, этап 1).
 *
 * Запуск (env нужен для обновления токена):
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/remote-sync.ts
 *   ... scripts/remote-sync.ts --check=Kraus_214_Bellucci_Granite_Refresh
 *
 * Сама синхронизация диск не трогает. --check дополнительно сверяет индекс
 * одного проекта с локальной папкой: только имена файлов в 04_JPG и 05_Outbox,
 * содержимое не читается.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../src/config';
import { getDb, schema } from '../src/db';
import { isConnected } from '../src/dropbox/tokens';
import { indexSummary, syncRemote } from '../src/remote';
import { isNoiseFile, projectKey } from '../src/scanner/parse';

const checkArg = process.argv.find((a) => a.startsWith('--check='))?.slice('--check='.length);

/** Файлы на диске под папкой, пути относительно корня Dropbox в нижнем регистре */
function localFiles(dir: string, rootLength: number, out: Map<string, number>) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) localFiles(full, rootLength, out);
    else if (!isNoiseFile(e.name)) {
      const rel = '/' + full.slice(rootLength + 1).split(path.sep).join('/').toLowerCase();
      out.set(rel, fs.statSync(full).size);
    }
  }
}

function check(folderName: string): boolean {
  const key = projectKey(folderName);
  const root = path.resolve(CONFIG.root);

  const local = new Map<string, number>();
  for (const sub of ['04_JPG', '05_Outbox']) localFiles(path.join(root, folderName, sub), root.length, local);

  const remote = new Map<string, number>();
  for (const row of getDb()
    .select()
    .from(schema.remoteEntries)
    .where(eq(schema.remoteEntries.projectKey, key))
    .all()) {
    if (row.isDir) continue;
    if (!/^\/[^/]+\/(04_jpg|05_outbox)\//.test(row.pathLower)) continue;
    if (isNoiseFile(row.name)) continue;
    remote.set(row.pathLower, row.size ?? -1);
  }

  const onlyLocal = [...local.keys()].filter((p) => !remote.has(p));
  const onlyRemote = [...remote.keys()].filter((p) => !local.has(p));
  const sizeDiff = [...local].filter(([p, size]) => remote.has(p) && remote.get(p) !== size);

  console.log(`\nСверка ${folderName} (04_JPG и 05_Outbox)`);
  console.log(`  на диске ${local.size}, в индексе ${remote.size}`);
  console.log(`  только на диске: ${onlyLocal.length}, только в индексе: ${onlyRemote.length}, размер расходится: ${sizeDiff.length}`);
  for (const p of onlyLocal.slice(0, 5)) console.log(`    диск:   ${p}`);
  for (const p of onlyRemote.slice(0, 5)) console.log(`    индекс: ${p}`);
  return onlyLocal.length === 0 && onlyRemote.length === 0 && sizeDiff.length === 0;
}

async function main() {
  if (!isConnected()) {
    console.error('Dropbox не подключён: открой доску и нажми иконку облака.');
    process.exit(1);
  }

  const result = await syncRemote();

  console.log(`Синхронизация индекса: ${result.durationMs} мс`);
  console.log(`  загружено проектов целиком: ${result.loaded.length}`);
  console.log(`  дельта: записей ${result.deltaEntries}, из них чужих ${result.deltaIgnored}`);
  console.log(`  затронуто проектов: ${result.touched.length}${result.touched.length ? ' — ' + result.touched.join(', ') : ''}`);
  if (result.missing.length) console.log(`  папки нет в корне Dropbox: ${result.missing.join(', ')}`);
  if (result.wasReset) console.log('  курсор протух — индекс перечитан заново');
  if (result.rateLimited) console.log(`  ответов 429: ${result.rateLimited}`);

  const summary = indexSummary();
  const files = summary.reduce((sum, p) => sum + p.files, 0);
  const dirs = summary.reduce((sum, p) => sum + p.dirs, 0);
  const pending = summary.filter((p) => !p.synced).length;
  console.log(`\nВ индексе: проектов ${summary.length}, файлов ${files}, папок ${dirs}, не загружено ${pending}`);

  if (checkArg && !check(checkArg)) process.exit(2);
}

main().catch((error) => {
  console.error('СБОЙ:', error instanceof Error ? error.message.slice(0, 400) : error);
  process.exit(1);
});
