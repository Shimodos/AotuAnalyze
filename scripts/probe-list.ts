/**
 * Этап 0 плана docs/PLAN-DROPBOX-API.md: можно ли получать состояние проектов
 * из Dropbox API вместо обхода диска.
 *
 * Проверяет четыре вещи:
 *   1. рекурсивный листинг одного проекта — скорость и состав;
 *   2. совпадают ли размер и дата файла из API с тем, что лежит на диске;
 *   3. отдаёт ли API превью для онлайн-заглушки, не скачивая сам файл;
 *   4. (--full) сколько длится листинг всего корня.
 *
 * Запуск (env нужен для обновления токена):
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/probe-list.ts
 *   ... scripts/probe-list.ts --project=Kraus_221_Indy_Sensor
 *   ... scripts/probe-list.ts --full --max-seconds=900
 *
 * Только чтение: в Dropbox ничего не пишет, с диска читает одни метаданные.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from '../src/config';
import { dropboxCall } from '../src/dropbox/client';
import { getAccessToken, isConnected, readSetting } from '../src/dropbox/tokens';

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const full = args.includes('--full');
const maxSeconds = Number(arg('max-seconds') ?? 600);
const projectArg = arg('project');

interface Entry {
  '.tag': 'file' | 'folder' | 'deleted';
  name: string;
  path_lower: string;
  path_display: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
}

interface ListResult {
  entries: Entry[];
  cursor: string;
  has_more: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Вызов с повтором при 429: лимиты Dropbox не публикует, только просит подождать */
async function call<T>(route: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await dropboxCall<T>(route, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('HTTP 429') || attempt >= 5) throw error;
      rateLimited++;
      await sleep(10_000);
    }
  }
}
let rateLimited = 0;

interface Listing {
  files: number;
  folders: number;
  pages: number;
  ms: number;
  finished: boolean;
  entries: Entry[];
}

/** Рекурсивный листинг; keep=false — только считаем, записи не храним */
async function listRecursive(root: string, keep: boolean, deadline = Infinity): Promise<Listing> {
  const started = Date.now();
  const out: Listing = { files: 0, folders: 0, pages: 0, ms: 0, finished: false, entries: [] };

  let page = await call<ListResult>('files/list_folder', { path: root, recursive: true, limit: 2000 });
  for (;;) {
    out.pages++;
    for (const e of page.entries) {
      if (e['.tag'] === 'file') out.files++;
      else if (e['.tag'] === 'folder') out.folders++;
      if (keep) out.entries.push(e);
    }
    if (!page.has_more) {
      out.finished = true;
      break;
    }
    if (Date.now() > deadline) break;
    if (!keep && out.pages % 20 === 0) {
      const sec = Math.round((Date.now() - started) / 1000);
      console.log(`     … страниц ${out.pages}, записей ${out.files + out.folders}, ${sec} с`);
    }
    page = await call<ListResult>('files/list_folder/continue', { cursor: page.cursor });
  }

  out.ms = Date.now() - started;
  return out;
}

/** Не занимает места на диске при ненулевом размере — онлайн-заглушка Dropbox */
function isOnlineOnly(st: fs.Stats): boolean {
  return st.size > 0 && st.blocks === 0;
}

async function thumbnail(apiPath: string): Promise<{ status: number; bytes: number; ms: number; note: string }> {
  const token = await getAccessToken();
  const apiArg = JSON.stringify({
    resource: { '.tag': 'path', path: apiPath },
    format: 'jpeg',
    size: 'w640h480',
    mode: 'fitone_bestfit',
    // заголовок HTTP — только ASCII
  }).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': apiArg };
  const root = readSetting('dropbox.root_namespace_id');
  if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify({ '.tag': 'root', root });

  const started = Date.now();
  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', { method: 'POST', headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    bytes: res.ok ? buf.length : 0,
    ms: Date.now() - started,
    note: res.ok ? '' : buf.toString('utf8').slice(0, 160),
  };
}

async function main() {
  if (!isConnected()) {
    console.error('Dropbox не подключён: открой доску и нажми иконку облака.');
    process.exit(1);
  }

  // ── корень
  const top = await call<ListResult>('files/list_folder', { path: '', limit: 2000 });
  const projects = top.entries
    .filter((e) => e['.tag'] === 'folder' && /^Kraus[_\s]/i.test(e.name))
    .map((e) => e.name)
    .sort();
  console.log(`1. Корень через API: записей ${top.entries.length}, папок проектов ${projects.length}`);

  const project = projectArg ?? projects[projects.length - 1];
  if (!project) throw new Error('В корне нет папок проектов — проверь командное пространство');

  // ── один проект целиком
  const one = await listRecursive('/' + project, true);
  console.log(`\n2. Проект ${project}: рекурсивный листинг`);
  console.log(`     файлов ${one.files}, папок ${one.folders}, страниц ${one.pages}, ${one.ms} мс`);

  // ── сверка с диском: только метаданные (stat), содержимое не читаем
  const localRoot = path.resolve(CONFIG.root);
  const relevant = one.entries.filter(
    (e) => e['.tag'] === 'file' && /\/(04_jpg|05_outbox)\//.test(e.path_lower),
  );
  let compared = 0;
  let missingLocal = 0;
  let sizeDiff = 0;
  let dateDiff = 0;
  let worstMs = 0;
  let worstName = '';
  let placeholder: Entry | null = null;
  let unsupported: Entry | null = null;

  for (const e of relevant.slice(0, 800)) {
    const local = path.join(localRoot, ...e.path_display.split('/').filter(Boolean));
    let st: fs.Stats;
    try {
      st = fs.statSync(local);
    } catch {
      missingLocal++;
      continue;
    }
    compared++;
    if (st.size !== e.size) sizeDiff++;
    const delta = Math.abs(st.mtimeMs - Date.parse(e.client_modified ?? ''));
    // API отдаёт дату с точностью до секунды
    if (!(delta < 2000)) dateDiff++;
    if (delta > worstMs) {
      worstMs = delta;
      worstName = e.name;
    }
    if (!placeholder && /\.jpe?g$/i.test(e.name) && isOnlineOnly(st)) placeholder = e;
  }
  unsupported =
    one.entries.find((e) => e['.tag'] === 'file' && /\.(exr|psd)$/i.test(e.name)) ?? null;

  console.log(`\n3. Сверка с диском (04_JPG и 05_Outbox, до 800 файлов)`);
  console.log(`     сравнено ${compared}, нет на диске ${missingLocal}`);
  console.log(`     размер расходится: ${sizeDiff}, дата расходится больше 2 с: ${dateDiff}`);
  console.log(`     худшее расхождение даты: ${Math.round(worstMs / 1000)} с${worstName ? ' (' + worstName + ')' : ''}`);

  // ── превью
  console.log('\n4. Превью через API (get_thumbnail_v2, w640h480)');
  if (placeholder) {
    const local = path.join(localRoot, ...placeholder.path_display.split('/').filter(Boolean));
    const t = await thumbnail(placeholder.path_display);
    const after = fs.statSync(local);
    console.log(`     онлайн-заглушка ${placeholder.name} (${placeholder.size} байт):`);
    console.log(`       HTTP ${t.status}, превью ${t.bytes} байт, ${t.ms} мс ${t.note}`);
    console.log(`       файл на диске после запроса: ${isOnlineOnly(after) ? 'по-прежнему заглушка' : 'СКАЧАН'}`);
  } else {
    console.log('     онлайн-заглушки среди jpg проекта не нашлось — пропуск');
  }
  if (unsupported) {
    const t = await thumbnail(unsupported.path_display);
    console.log(`     ${path.extname(unsupported.name)} ${unsupported.name} (${unsupported.size} байт):`);
    console.log(`       HTTP ${t.status}, превью ${t.bytes} байт, ${t.ms} мс ${t.note}`);
  }

  // ── весь корень
  if (full) {
    console.log(`\n5. Листинг всего корня (не дольше ${maxSeconds} с)`);
    const all = await listRecursive('', false, Date.now() + maxSeconds * 1000);
    const total = all.files + all.folders;
    const perSec = Math.round(total / (all.ms / 1000));
    console.log(
      `     ${all.finished ? 'ЗАВЕРШЁН' : 'ПРЕРВАН по времени'}: файлов ${all.files}, папок ${all.folders}, ` +
        `страниц ${all.pages}, ${Math.round(all.ms / 1000)} с, ~${perSec} записей/с`,
    );
  }

  console.log(`\nОтветов 429 (превышение лимита): ${rateLimited}`);
}

main().catch((error) => {
  console.error('СБОЙ:', error instanceof Error ? error.message.slice(0, 400) : error);
  process.exit(1);
});
