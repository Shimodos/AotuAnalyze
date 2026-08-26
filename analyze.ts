/**
 * Viarde Project Tracker — анализатор структуры (Фаза 0)
 *
 * Запуск:  npx tsx analyze.ts
 * Зависимостей нет, только Node 18+.
 *
 * Что делает:
 *  1. Находит проекты Kraus_NNN_* в корне Dropbox
 *  2. Парсит 05_Outbox -> отгрузки клиенту (стадия + круг правок)
 *  3. Парсит 04_JPG -> сцены, пустая папка = моделинг, есть картинки = визуализация
 *  4. Ищет фидбек клиента в 01_Clients
 *  5. Считает итоговую стадию проекта и прогресс по сценам
 *  6. Пишет два отчёта: report.json (данные) и anomalies.txt (что чинить в папках)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─────────────────────────────────────────────────────────────
// КОНФИГ — правь здесь
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  root: 'D:\\Viarde Studio Dropbox',
  outDir: 'D:\\tracker-report',

  /** Папки в корне, которые НЕ являются проектами */
  notProjects: ['Kraus_Start', 'Kraus_1001_Small_task'],

  /** Расширения, которые считаем значащим результатом рендера */
  imageExtensions: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.exr', '.webp'],

  /** Файл меньше этого размера считаем мусором (байты). 100 КБ */
  minFileSize: 100 * 1024,

  /** Служебные имена папок-сцен — не участвуют в подсчёте прогресса */
  serviceSceneNames: [
    'studio', 'studios', 'test', 'tests', 'old', 'prev', 'temp', 'tmp',
    'new folder', 'cam_ref', 'backgrounds', 'test backgrounds', 'lessons',
  ],

  /** Маркеры мусора в именах папок Outbox — такие отгрузки игнорируем */
  outboxJunkMarkers: ['test', 'material', 'old', 'scenes', 'studio', 'people', 'dof'],

  /** Насколько глубоко лезем внутрь папки сцены в поисках картинок */
  sceneScanDepth: 3,
};

// ─────────────────────────────────────────────────────────────
// СТАДИИ
// ─────────────────────────────────────────────────────────────

const Stage = {
  UNKNOWN: { weight: -1, label: 'Не определено' },
  NEW: { weight: 0, label: 'Новый проект' },
  MODELING: { weight: 1, label: 'Моделинг' },
  FAST_PREVIEW: { weight: 2, label: 'Fast Preview у клиента' },
  RENDERING: { weight: 3, label: 'Визуализация' },
  PREVIEW: { weight: 4, label: 'Preview у клиента' },
  PREFINAL: { weight: 5, label: 'Prefinal у клиента' },
  FINAL: { weight: 6, label: 'Финал' },
} as const;

type StageKey = keyof typeof Stage;

// ─────────────────────────────────────────────────────────────
// ТИПЫ
// ─────────────────────────────────────────────────────────────

interface Delivery {
  folderName: string;
  stage: StageKey;
  round: number | null;
  mtime: Date;
  isJunk: boolean;
}

interface Scene {
  name: string;
  skus: string[];
  sceneNumber: string | null;
  isService: boolean;
  imageCount: number;
  maxVersion: string | null;
  versions: string[];
  mtime: Date;
}

interface Project {
  folderName: string;
  jobNumber: number | null;
  title: string;
  hasStandardStructure: boolean;
  missingFolders: string[];
  deliveries: Delivery[];
  scenes: Scene[];
  clientFeedbackFolders: string[];
  stage: StageKey;
  stageEvidence: string;
  stageSince: Date | null;
  daysInStage: number | null;
  currentRound: number | null;
  scenesTotal: number;
  scenesRendered: number;
  anomalies: string[];
}

const STANDARD_FOLDERS = [
  '01_Clients', '02_Inspiration', '03_Models',
  '04_EXR', '04_JPG', '04_PSD', '05_Outbox', '06_Textures',
];

// ─────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────────────

function listDirs(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function mtimeOf(p: string): Date {
  try {
    return fs.statSync(p).mtime;
  } catch {
    return new Date(0);
  }
}

function daysSince(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/** Нормализация имени для сравнения: нижний регистр, пробелы/дефисы -> подчёркивание */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[\s\-]+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// ПАРСЕРЫ
// ─────────────────────────────────────────────────────────────

/** Kraus_211_Gold_Finish_Refresh -> { jobNumber: 211, title: 'Gold Finish Refresh' } */
function parseProjectName(folderName: string) {
  const m = folderName.match(/^Kraus[_\s]+(\d{2,4})[_\s]+(.+)$/i);
  if (!m) return { jobNumber: null, title: folderName };
  return {
    jobNumber: parseInt(m[1], 10),
    title: m[2].replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Определяет стадию по имени папки в 05_Outbox.
 * ВАЖЕН ПОРЯДОК: prefinal проверяем до preview и до final.
 */
function parseDelivery(folderName: string, projectFolder: string, mtime: Date): Delivery {
  let s = normalize(folderName);
  const proj = normalize(projectFolder);

  // отрезаем префикс имени проекта, если он есть
  if (s.startsWith(proj)) s = s.slice(proj.length);
  // отрезаем ведущий номер джоба (147_Bolden_..._Final)
  s = s.replace(/^_?\d{2,4}_/, '');
  s = s.replace(/^kraus_/, '').replace(/^_+/, '');

  const isJunk = CONFIG.outboxJunkMarkers.some((m) => s.includes(m));

  let stage: StageKey = 'UNKNOWN';
  if (/prefinal/.test(s)) stage = 'PREFINAL';
  else if (/fast_?preview/.test(s)) stage = 'FAST_PREVIEW';
  else if (/final/.test(s)) stage = 'FINAL';
  else if (/preview/.test(s)) stage = 'PREVIEW';

  // круг правок: хвостовые цифры (_01, _1, _001, " 2")
  const roundMatch = s.match(/[_\s](\d{1,3})$/);
  const round = roundMatch ? parseInt(roundMatch[1], 10) : null;

  return { folderName, stage, round, mtime, isJunk };
}

/**
 * KHT632-33-C_KHT641-25-C_KPF-1610SFS-DP02-C_Scene_2
 *   -> skus: [KHT632-33-C, KHT641-25-C, KPF-1610SFS-DP02-C], sceneNumber: '2'
 */
function parseSceneName(name: string) {
  const isService = CONFIG.serviceSceneNames.includes(normalize(name).replace(/_/g, ' '))
    || CONFIG.serviceSceneNames.includes(name.toLowerCase().trim());

  const sceneMatch = name.match(/(?:scene|angle)[_\s]?(\d{1,3})/i);
  const sceneNumber = sceneMatch ? sceneMatch[1] : null;

  // артикулы Kraus: 2-4 буквы, дефис, цифры
  const skus = (name.match(/\b[A-Z]{2,4}[UTHFSWDPC]*[-_]?\d{2,4}[A-Z0-9\-]*/g) ?? [])
    .filter((t) => !/^scene/i.test(t) && !/^angle/i.test(t));

  return { isService, sceneNumber, skus };
}

/** Рекурсивно считает значащие изображения внутри папки сцены */
function countImages(dir: string, depth = 0): { count: number; samples: string[] } {
  if (depth > CONFIG.sceneScanDepth) return { count: 0, samples: [] };

  let count = 0;
  const samples: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { count: 0, samples: [] };
  }

  for (const e of entries) {
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      const nested = countImages(full, depth + 1);
      count += nested.count;
      samples.push(...nested.samples.slice(0, 3));
      continue;
    }

    if (e.name.startsWith('.') || e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue;

    const ext = path.extname(e.name).toLowerCase();
    if (!CONFIG.imageExtensions.includes(ext)) continue;

    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size < CONFIG.minFileSize) continue;

    count++;
    if (samples.length < 3) samples.push(e.name);
  }

  return { count, samples };
}

// ─────────────────────────────────────────────────────────────
// АНАЛИЗ ПРОЕКТА
// ─────────────────────────────────────────────────────────────

const filenameSamples = new Set<string>();

function analyzeProject(projectPath: string, folderName: string): Project {
  const { jobNumber, title } = parseProjectName(folderName);
  const anomalies: string[] = [];

  if (jobNumber === null) anomalies.push('Имя проекта не соответствует шаблону Kraus_NNN_Название');
  if (/\s/.test(folderName)) anomalies.push('В имени папки есть пробелы вместо подчёркиваний');
  if (/[’']/.test(folderName)) anomalies.push('В имени папки апостроф — проблемный символ для URL');
  if (/[()+]/.test(folderName)) anomalies.push('В имени папки скобки или плюс');
  if (/_\s|\s_/.test(folderName)) anomalies.push('Лишний пробел рядом с подчёркиванием');

  const present = new Set(listDirs(projectPath).map((d) => d.name));
  const missingFolders = STANDARD_FOLDERS.filter((f) => !present.has(f));
  const hasStandardStructure = missingFolders.length === 0;

  // ── 05_Outbox: отгрузки клиенту
  const deliveries: Delivery[] = [];
  const outboxPath = path.join(projectPath, '05_Outbox');
  if (exists(outboxPath)) {
    for (const d of listDirs(outboxPath)) {
      const del = parseDelivery(d.name, folderName, mtimeOf(path.join(outboxPath, d.name)));
      deliveries.push(del);
      if (del.stage === 'UNKNOWN' && !del.isJunk) {
        anomalies.push(`Outbox: непонятная папка "${d.name}" — стадия не распознана`);
      }
    }
  }

  // ── 04_JPG: сцены
  const scenes: Scene[] = [];
  const jpgPath = path.join(projectPath, '04_JPG');
  if (exists(jpgPath)) {
    for (const d of listDirs(jpgPath)) {
      const scenePath = path.join(jpgPath, d.name);
      const parsed = parseSceneName(d.name);
      const { count, samples } = countImages(scenePath);
      samples.forEach((s) => filenameSamples.add(s));

      const versionDirs = listDirs(scenePath)
        .map((v) => v.name)
        .filter((v) => /^\d{1,3}$/.test(v))
        .sort();

      if (!parsed.isService && parsed.skus.length === 0) {
        anomalies.push(`04_JPG: сцена "${d.name}" — не распознан ни один артикул`);
      }
      const nonStandardVersions = listDirs(scenePath)
        .map((v) => v.name)
        .filter((v) => !/^\d{1,3}$/.test(v));
      if (nonStandardVersions.length > 0) {
        anomalies.push(`04_JPG/${d.name}: нестандартные подпапки — ${nonStandardVersions.join(', ')}`);
      }

      scenes.push({
        name: d.name,
        skus: parsed.skus,
        sceneNumber: parsed.sceneNumber,
        isService: parsed.isService,
        imageCount: count,
        maxVersion: versionDirs.length ? versionDirs[versionDirs.length - 1] : null,
        versions: versionDirs,
        mtime: mtimeOf(scenePath),
      });
    }
  }

  // ── 01_Clients: фидбек клиента
  const clientFeedbackFolders: string[] = [];
  const clientsPath = path.join(projectPath, '01_Clients');
  if (exists(clientsPath)) {
    for (const d of listDirs(clientsPath)) {
      if (/comment|feedback|correction|post_ref|правк/i.test(d.name)) {
        clientFeedbackFolders.push(d.name);
      }
    }
  }

  // ── Вычисление стадии
  const realScenes = scenes.filter((s) => !s.isService);
  const scenesTotal = realScenes.length;
  const scenesRendered = realScenes.filter((s) => s.imageCount > 0).length;

  // стадия из сцен
  let sceneStage: StageKey = 'UNKNOWN';
  if (scenesTotal > 0) {
    sceneStage = scenesRendered === 0 ? 'MODELING'
      : scenesRendered < scenesTotal ? 'RENDERING'
      : 'RENDERING';
  } else if (exists(path.join(projectPath, '03_Models'))) {
    sceneStage = 'MODELING';
  } else if (exists(clientsPath)) {
    sceneStage = 'NEW';
  }

  // стадия из отгрузок — берём максимальный вес
  const validDeliveries = deliveries.filter((d) => !d.isJunk && d.stage !== 'UNKNOWN');
  let topDelivery: Delivery | null = null;
  for (const d of validDeliveries) {
    if (!topDelivery || Stage[d.stage].weight > Stage[topDelivery.stage].weight) topDelivery = d;
    else if (Stage[d.stage].weight === Stage[topDelivery.stage].weight && d.mtime > topDelivery.mtime) topDelivery = d;
  }

  let stage: StageKey = sceneStage;
  let stageEvidence = scenesTotal > 0
    ? `04_JPG: отрендерено ${scenesRendered} из ${scenesTotal} сцен`
    : '03_Models';
  let stageSince: Date | null = null;

  if (topDelivery && Stage[topDelivery.stage].weight > Stage[sceneStage].weight) {
    stage = topDelivery.stage;
    stageEvidence = `05_Outbox/${topDelivery.folderName}`;
    stageSince = topDelivery.mtime;
  } else if (scenes.length > 0) {
    stageSince = new Date(Math.max(...scenes.map((s) => s.mtime.getTime())));
  }

  // текущий круг правок — максимальный номер среди отгрузок текущей стадии
  const roundsAtStage = validDeliveries
    .filter((d) => d.stage === stage && d.round !== null)
    .map((d) => d.round as number);
  const currentRound = roundsAtStage.length ? Math.max(...roundsAtStage) : null;

  if (currentRound !== null && currentRound >= 4) {
    anomalies.push(`Много кругов правок: ${currentRound} на стадии ${Stage[stage].label}`);
  }

  return {
    folderName, jobNumber, title,
    hasStandardStructure, missingFolders,
    deliveries, scenes, clientFeedbackFolders,
    stage, stageEvidence, stageSince,
    daysInStage: stageSince ? daysSince(stageSince) : null,
    currentRound, scenesTotal, scenesRendered,
    anomalies,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

function main() {
  if (!exists(CONFIG.root)) {
    console.error(`Не найден путь: ${CONFIG.root}`);
    console.error('Поправь CONFIG.root в начале файла.');
    process.exit(1);
  }

  const projectFolders = listDirs(CONFIG.root)
    .map((d) => d.name)
    .filter((n) => /^Kraus[_\s]/i.test(n))
    .filter((n) => !CONFIG.notProjects.includes(n));

  console.log(`Найдено проектов: ${projectFolders.length}\n`);

  const projects: Project[] = [];
  for (const name of projectFolders) {
    process.stdout.write(`  сканирую ${name} ... `);
    const p = analyzeProject(path.join(CONFIG.root, name), name);
    projects.push(p);
    console.log(`${Stage[p.stage].label}`);
  }

  // сортировка по номеру джоба, свежие сверху
  projects.sort((a, b) => (b.jobNumber ?? 0) - (a.jobNumber ?? 0));

  // ── Таблица
  console.log('\n' + '─'.repeat(110));
  console.log(
    'Джоб'.padEnd(6) +
    'Проект'.padEnd(34) +
    'Стадия'.padEnd(24) +
    'Круг'.padEnd(6) +
    'Сцены'.padEnd(9) +
    'Дней'.padEnd(6) +
    'Стр.'
  );
  console.log('─'.repeat(110));

  for (const p of projects) {
    console.log(
      String(p.jobNumber ?? '?').padEnd(6) +
      p.title.slice(0, 32).padEnd(34) +
      Stage[p.stage].label.padEnd(24) +
      (p.currentRound !== null ? `#${p.currentRound}` : '—').padEnd(6) +
      (p.scenesTotal > 0 ? `${p.scenesRendered}/${p.scenesTotal}` : '—').padEnd(9) +
      String(p.daysInStage ?? '—').padEnd(6) +
      (p.hasStandardStructure ? 'ok' : `нет: ${p.missingFolders.length}`)
    );
  }
  console.log('─'.repeat(110));

  // ── Сводка по колонкам канбана
  console.log('\nРаспределение по колонкам:');
  const byStage = new Map<StageKey, number>();
  for (const p of projects) byStage.set(p.stage, (byStage.get(p.stage) ?? 0) + 1);
  for (const key of Object.keys(Stage) as StageKey[]) {
    const n = byStage.get(key);
    if (n) console.log(`  ${Stage[key].label.padEnd(24)} ${n}`);
  }

  // ── Аномалии
  const allAnomalies = projects.flatMap((p) => p.anomalies.map((a) => `[${p.folderName}] ${a}`));
  console.log(`\nОтклонений от конвенции: ${allAnomalies.length}`);

  // ── Запись отчётов
  fs.mkdirSync(CONFIG.outDir, { recursive: true });

  fs.writeFileSync(
    path.join(CONFIG.outDir, 'report.json'),
    JSON.stringify(projects, null, 2),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(CONFIG.outDir, 'anomalies.txt'),
    allAnomalies.join('\n') + '\n\n' +
    '─── Примеры имён файлов (для построения whitelist-паттерна) ───\n' +
    [...filenameSamples].slice(0, 200).join('\n'),
    'utf-8'
  );

  console.log(`\nОтчёты записаны в ${CONFIG.outDir}`);
  console.log('  report.json    — полные данные по каждому проекту');
  console.log('  anomalies.txt  — список того, что стоит поправить в папках');
}

main();
