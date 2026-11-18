/**
 * Сверка двух источников: скан по диску против скана по индексу Dropbox
 * (docs/PLAN-DROPBOX-API.md, этап 2). Переключать доску на индекс можно
 * только когда расхождений нет или каждое объяснено.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/compare-scan.ts
 *   ... scripts/compare-scan.ts --no-sync      # не обновлять индекс перед сверкой
 *   ... scripts/compare-scan.ts --verbose      # все расхождения, а не первые по проекту
 *
 * Диск читается так же, как при обычном скане (только метаданные), и без кеша.
 * Стадию считаем обоими способами и сравниваем — это то, что видно на доске.
 */

import { isConnected } from '../src/dropbox/tokens';
import { syncRemote } from '../src/remote';
import { scanFromIndex } from '../src/remote/scan';
import { DISK_FS } from '../src/scanner/fs';
import { scanAll, type ScannedProject } from '../src/scanner/scan';
import { computeStage } from '../src/scanner/stage';

const verbose = process.argv.includes('--verbose');
const noSync = process.argv.includes('--no-sync');

/** Dropbox хранит дату файла с точностью до секунды, диск — точнее */
const TIME_TOLERANCE_MS = 2000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value);
}

/** Рекурсивное сравнение; пути расхождений складываются в out */
function diff(a: Json, b: Json, at: string, out: string[]) {
  if (isIsoDate(a) && isIsoDate(b)) {
    if (Math.abs(Date.parse(a) - Date.parse(b)) > TIME_TOLERANCE_MS) out.push(`${at}: диск ${a} ≠ api ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${at}: длина диск ${a.length} ≠ api ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff(a[key] ?? null, b[key] ?? null, at ? `${at}.${key}` : key, out);
    }
    return;
  }
  if (a === b) return;

  // Обложка — «самый свежий кадр». Если два кадра сохранены в одну секунду,
  // диск их различает по долям секунды, а Dropbox нет: выбор между ними
  // равноправен и расхождением не считается.
  if (at.endsWith('coverPath') && typeof a === 'string' && typeof b === 'string') {
    try {
      const delta = Math.abs(DISK_FS.stat(a).mtimeMs - DISK_FS.stat(b).mtimeMs);
      if (delta <= TIME_TOLERANCE_MS) {
        coverTies++;
        return;
      }
    } catch {
      /* одного из файлов нет на диске — это уже настоящее расхождение */
    }
  }

  out.push(`${at}: диск ${JSON.stringify(a)} ≠ api ${JSON.stringify(b)}`);
}

let coverTies = 0;

/** Сцены и отгрузки сравниваем по имени, а не по позиции в списке */
function keyed(project: ScannedProject) {
  const plain = JSON.parse(JSON.stringify(project)) as { [key: string]: Json };
  const byName = (list: Json, field: string) =>
    Object.fromEntries(
      ((list as Array<{ [key: string]: Json }>) ?? []).map((item) => [String(item[field]), item]),
    );
  return { ...plain, scenes: byName(plain.scenes, 'name'), deliveries: byName(plain.deliveries, 'folderName') };
}

async function main() {
  if (!isConnected()) {
    console.error('Dropbox не подключён: открой доску и нажми иконку облака.');
    process.exit(1);
  }

  if (!noSync) {
    const sync = await syncRemote();
    console.log(
      `Индекс обновлён за ${sync.durationMs} мс: загружено ${sync.loaded.length}, дельта ${sync.deltaEntries}, затронуто ${sync.touched.length}`,
    );
  }

  let started = Date.now();
  const api = await scanFromIndex();
  const apiMs = Date.now() - started;

  started = Date.now();
  const disk = scanAll();
  const diskMs = Date.now() - started;

  console.log(`Скан по индексу: ${api.projects.length} проектов за ${apiMs} мс (планов скачано ${api.plans.downloaded})`);
  console.log(`Скан по диску:   ${disk.length} проектов за ${diskMs} мс`);
  for (const f of api.plans.failed) console.log(`  план не скачан — ${f}`);

  const apiByKey = new Map(api.projects.map((p) => [p.key, p]));
  const diskByKey = new Map(disk.map((p) => [p.key, p]));

  const onlyDisk = disk.filter((p) => !apiByKey.has(p.key)).map((p) => p.folderName);
  const onlyApi = api.projects.filter((p) => !diskByKey.has(p.key)).map((p) => p.folderName);
  if (onlyDisk.length) console.log(`\nТолько на диске (не отслеживаются): ${onlyDisk.join(', ')}`);
  if (onlyApi.length) console.log(`\nТолько в индексе (нет на диске этой машины): ${onlyApi.join(', ')}`);

  const now = new Date();
  let clean = 0;
  let differing = 0;
  let stageDiffers = 0;

  console.log('');
  for (const d of disk) {
    const a = apiByKey.get(d.key);
    if (!a) continue;

    const found: string[] = [];
    diff(keyed(d) as Json, keyed(a) as Json, '', found);

    const stageDisk = computeStage(d, now);
    const stageApi = computeStage(a, now);
    const stageFound: string[] = [];
    diff(JSON.parse(JSON.stringify(stageDisk)), JSON.parse(JSON.stringify(stageApi)), 'stage', stageFound);

    if (found.length === 0 && stageFound.length === 0) {
      clean++;
      continue;
    }
    differing++;
    if (stageDisk.column !== stageApi.column) stageDiffers++;

    console.log(`✗ ${d.folderName}: расхождений ${found.length}, в стадии ${stageFound.length}` +
      (stageDisk.column !== stageApi.column ? `  ← КОЛОНКА: диск ${stageDisk.column}, api ${stageApi.column}` : ''));
    const all = [...stageFound, ...found];
    for (const line of verbose ? all : all.slice(0, 6)) console.log(`    ${line}`);
    if (!verbose && all.length > 6) console.log(`    … ещё ${all.length - 6}`);
  }

  console.log(`\nСовпадают полностью: ${clean}, расходятся: ${differing}, из них колонка на доске другая: ${stageDiffers}`);
  if (coverTies) console.log(`Равноправный выбор обложки (кадры одной секунды): ${coverTies}`);
  process.exit(differing === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error('СБОЙ:', error instanceof Error ? error.message.slice(0, 400) : error);
  process.exit(1);
});
