/**
 * Сборка трекера в одну самостоятельную папку: dist/ViardeTracker.
 *
 *   node scripts/pack.mjs
 *
 * Внутри — Node, собранный сервер и скан. На машине, куда папку перенесли,
 * ничего ставить не нужно. Запуск: ViardeTracker.exe — значок в области
 * уведомлений (scripts/pack/tray), либо node\node.exe start.cjs в консоли.
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

// ── 4. Значок в области уведомлений
step('значок в трее');

// Иконка из того же SVG, что и значок вкладки. Мелкие размеры — несжатые
// растры: их понимают и компилятор ресурсов, и старый код Windows; 256 px
// кладётся как PNG, иначе файл раздувается до сотен килобайт.
// sharp берём из самого проекта, а не из временной копии: его нативная
// библиотека остаётся загруженной в этот процесс, и копию было бы не удалить.
const sharp = createRequire(path.join(project, 'package.json'))('sharp');
const svg = fs.readFileSync(path.join(work, 'src', 'app', 'icon.svg'));

async function iconImage(size) {
  // density с запасом: SVG нарисован в 32 px, а нужен чёткий растр до 256
  const image = sharp(svg, { density: 72 * (size / 32) * 2 }).resize(size, size);
  if (size >= 256) return image.png().toBuffer();

  const rgba = await image.ensureAlpha().raw().toBuffer();
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // высота удвоена: цвет и маска
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4; // строки снизу вверх, BGRA
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const mask = Buffer.alloc((Math.ceil(size / 32) * 4) * size); // прозрачность берётся из альфа-канала
  return Buffer.concat([header, pixels, mask]);
}

const sizes = [16, 24, 32, 48, 64, 256];
const images = await Promise.all(sizes.map(iconImage));
const dir = Buffer.alloc(6 + sizes.length * 16);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((size, i) => {
  const at = 6 + i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, at);
  dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
  dir.writeUInt16LE(1, at + 4);
  dir.writeUInt16LE(32, at + 6);
  dir.writeUInt32LE(images[i].length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
const icoPath = path.join(out, 'tracker.ico');
fs.writeFileSync(icoPath, Buffer.concat([dir, ...images]));

// Компилятор C# из самой Windows: под .NET Framework 4.x, который есть в
// Windows 10 и 11 из коробки, — на чужой машине ставить ничего не придётся
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    `/win32icon:${icoPath}`,
    `/out:${path.join(out, 'ViardeTracker.exe')}`,
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    path.join(project, 'scripts', 'pack', 'tray', 'Program.cs'),
  ],
  { stdio: 'inherit' },
);

// ── 5. Node и запуск
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
console.log('Запуск: ViardeTracker.exe (значок в трее) или node\\node.exe start.cjs (в консоли)');

// ── 6. Установщик — если на машине есть Inno Setup 6. Без него сборка всё
//       равно готова: папку можно перенести и запустить как есть.
const iscc = [
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
].find((candidate) => fs.existsSync(candidate));

if (iscc) {
  step('установщик');
  const { version } = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  execFileSync(
    iscc,
    [
      '/Qp',
      `/DAppVersion=${version}`,
      `/DSourceDir=${out}`,
      `/DOutputDir=${path.join(project, 'dist')}`,
      path.join(project, 'scripts', 'pack', 'installer.iss'),
    ],
    { stdio: 'inherit' },
  );
  console.log(`Установщик: ${path.join(project, 'dist', `ViardeTrackerSetup-${version}.exe`)}`);
} else {
  console.log('Inno Setup 6 не найден — установщик не собран (https://jrsoftware.org/isinfo.php)');
}
