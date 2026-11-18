/**
 * Сборка трекера в одну самостоятельную папку: dist/ViardeTracker.
 *
 *   node scripts/pack.mjs
 *
 * Внутри — Node, собранный сервер и скан. На машине, куда папку перенесли,
 * ничего ставить не нужно. Запуск: node\node.exe start.cjs
 *
 * Собираем во временной копии, а не в папке проекта: `next build` пишет
 * в .next, и если в это время работает `npm run dev`, оба затирают файлы
 * друг друга — доска остаётся без стилей.
 *
 * Запускать тем же Node, под который собран better-sqlite3 (см. .node-version):
 * этот же node.exe кладётся в сборку.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(os.tmpdir(), 'viarde-tracker-pack');
const out = path.join(project, 'dist', 'ViardeTracker');
const appOut = path.join(out, 'app');

const step = (text) => console.log(`\n== ${text}`);

// ── 0. Ключ приложения Dropbox. Не секрет (вход идёт по PKCE), но в
//       репозиторий не коммитим: берём из окружения или из .env.local.
function appKey() {
  if (process.env.DROPBOX_APP_KEY) return process.env.DROPBOX_APP_KEY;
  const envFile = path.join(project, '.env.local');
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DROPBOX_APP_KEY='));
    if (line) return line.slice('DROPBOX_APP_KEY='.length).trim();
  }
  throw new Error('Нет DROPBOX_APP_KEY: задайте переменную или строку в .env.local');
}
const dropboxAppKey = appKey();

const wanted = fs.readFileSync(path.join(project, '.node-version'), 'utf8').trim();
if (process.version !== `v${wanted}`) {
  throw new Error(`Сборку нужно запускать Node ${wanted} (сейчас ${process.version}): он же кладётся внутрь`);
}

// ── 1. Временная копия проекта
step(`копия проекта в ${work}`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
for (const name of ['src', 'scripts', 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json']) {
  fs.cpSync(path.join(project, name), path.join(work, name), { recursive: true });
}
// Настоящая копия, а не ссылка: сборщик выясняет, какие файлы пакетов нужны
// серверу, и по ссылке ушёл бы за пределы временной папки
fs.cpSync(path.join(project, 'node_modules'), path.join(work, 'node_modules'), { recursive: true });

// ── 2. Сервер
step('сборка сервера');
execFileSync(process.execPath, [path.join(work, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
  cwd: work,
  stdio: 'inherit',
  env: { ...process.env, VIARDE_PACK: '1', NEXT_TELEMETRY_DISABLED: '1' },
});

step(`сборка в ${out}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(work, '.next', 'standalone'), appOut, { recursive: true });
// Статику сборщик в standalone не кладёт — её нужно скопировать рядом
fs.cpSync(path.join(work, '.next', 'static'), path.join(appOut, '.next', 'static'), { recursive: true });

// ── 3. Скан одним файлом. В сборке нет ни исходников, ни tsx.
//       esbuild берём тот, что уже стоит вместе с tsx.
step('сборка скана');
const requireFromTsx = createRequire(path.join(work, 'node_modules', 'tsx', 'package.json'));
const esbuild = requireFromTsx('esbuild');
await esbuild.build({
  absWorkingDir: work,
  entryPoints: ['scripts/scan.ts'],
  outfile: path.join(appOut, 'scan.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // нативный модуль не бандлится — берётся из node_modules собранного сервера
  external: ['better-sqlite3'],
  logLevel: 'warning',
});
// esbuild держит фоновый процесс и вместе с ним свой exe во временной папке —
// без остановки её потом не удалить
await esbuild.stop();

// ── 4. Node и запуск
step('Node и запускающий скрипт');
fs.mkdirSync(path.join(out, 'node'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(out, 'node', 'node.exe'));
fs.copyFileSync(path.join(project, 'scripts', 'pack', 'start.cjs'), path.join(out, 'start.cjs'));
fs.writeFileSync(path.join(out, 'app.json'), JSON.stringify({ dropboxAppKey }, null, 2) + '\n');

// В сборку не должны попасть ни секрет, ни рабочая база
for (const leak of ['.env.local', '.env', 'data']) {
  if (fs.existsSync(path.join(appOut, leak))) throw new Error(`в сборку попало лишнее: ${leak}`);
}

// Сборка уже готова; неубранная временная папка — не повод считать её неудачной
try {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  console.warn(`временную папку убрать не удалось (${error.code}): ${work}`);
}

const size = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((sum, e) => {
    return e.isFile() ? sum + fs.statSync(path.join(e.parentPath, e.name)).size : sum;
  }, 0);
console.log(`\nГотово: ${out} — ${(size(out) / 1048576).toFixed(0)} МБ`);
console.log('Запуск: node\\node.exe start.cjs');
