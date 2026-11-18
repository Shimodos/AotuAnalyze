/**
 * Обход диска. Читает, ничего не пишет — файловая система источник истины.
 *
 * Время отгрузки берём как максимум mtime ФАЙЛОВ внутри папки, а не mtime самой папки.
 * Две причины:
 *  1. Пустая папка не получает времени и не считается отгрузкой — на реальных данных
 *     шаблонные пустые 05_Outbox/Final ставили 27 из 29 проектов в «Финал».
 *  2. У FolderMetadata в Dropbox API вообще нет timestamp-полей, только у FileMetadata.
 *     Так логика сразу совместима с переездом на API.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { CONFIG, type DeliveryKind, type ScenePhase } from '@/config';
import type { Localized } from '@/i18n/types';
import { NO_CACHE, type ScanCache } from './cache';
import { scanFs, type ScanEntry, type ScanStat } from './fs';
import { assignPlans, findPlanFile, parsePlan, type ScenePlan } from './plan';
import {
  isImage,
  isNoiseFile,
  parseDelivery,
  parseProjectName,
  parseSceneName,
  normalizeShortName,
  projectKey,
  sceneSuffix,
  sortVersions,
} from './parse';

export type { ScenePhase };

export interface ScannedDelivery {
  folderName: string;
  kind: DeliveryKind | null;
  round: number | null;
  isJunk: boolean;
  fileCount: number;
  /** null, если папка пуста */
  sentAt: Date | null;
  /** самая свежая картинка отгрузки — запасная обложка карточки */
  coverPath: string | null;
  coverAt: Date | null;
}

/** Нумерованная подпапка сцены — этап рендера. Показываем, но в прогресс не считаем. */
export interface SceneVersion {
  name: string;
  imageCount: number;
}

export interface ScannedScene {
  name: string;
  skus: string[];
  sceneNumber: string | null;
  isService: boolean;
  /** Готовые JPG в корне папки сцены — результат ручной конвертации */
  imageCount: number;
  /**
   * Сырые EXR из 04_EXR. Они приходят с рендер-ферм автоматически,
   * поэтому это признак «рендер идёт прямо сейчас», в отличие от JPG,
   * которые переносит человек.
   */
  exrCount: number;
  lastExrAt: Date | null;
  /** файлы постобработки из 04_PSD */
  psdCount: number;
  lastPsdAt: Date | null;
  /** имя привязанной папки в 04_PSD — оно может отличаться от имени сцены */
  psdFolder: string | null;
  /** подпапки-этапы внутри папки PSD */
  psdStages: SceneVersion[];
  /** сколько кадров этой сцены запланировано в таблице клиента */
  plannedTotal: number;
  /** сколько кадров плана нашлось по точному имени файла */
  plannedMatched: number;
  /** имена из плана, которых нет на диске */
  plannedMissing: string[];
  /** заголовки групп таблицы, отнесённых к сцене */
  plannedGroups: string[];
  phase: ScenePhase;
  versions: SceneVersion[];
  lastImageAt: Date | null;
  /** путь к самой свежей картинке — обложка карточки */
  coverPath: string | null;
  /** есть файлы с рендерными расширениями, но все отсеяны по размеру */
  hasUnrecognizedFiles: boolean;
}

export interface ScannedProject {
  key: string;
  folderName: string;
  path: string;
  jobNumber: number | null;
  title: string;
  hasStandardStructure: boolean;
  missingFolders: string[];
  deliveries: ScannedDelivery[];
  scenes: ScannedScene[];
  clientFeedbackFolders: string[];
  anomalies: Localized[];
  sizeBytes: number | null;
}

function listEntries(dir: string): ScanEntry[] {
  try {
    return scanFs().readdir(dir);
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  return listEntries(dir)
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function exists(p: string): boolean {
  try {
    return scanFs().exists(p);
  } catch {
    return false;
  }
}

interface FolderSummary {
  fileCount: number;
  newest: Date | null;
  /** самая свежая значащая картинка внутри — годится как обложка */
  coverPath: string | null;
  coverAt: Date | null;
}

/** Дерево папки отгрузки: каждый каталог прочитан один раз, stat — только у каталогов */
interface DirTree {
  dir: string;
  mtimeMs: number;
  files: string[];
  subdirs: DirTree[];
}

function readTree(dir: string, depth = 0): DirTree | null {
  if (depth > CONFIG.outboxScanDepth) return null;
  let entries: ScanEntry[];
  try {
    entries = scanFs().readdir(dir);
  } catch {
    return null;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = scanFs().stat(dir).mtimeMs;
  } catch {
    /* каталог исчез между readdir и stat — отпечаток просто не совпадёт в следующий раз */
  }

  const tree: DirTree = { dir, mtimeMs, files: [], subdirs: [] };
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = readTree(path.join(dir, e.name), depth + 1);
      if (nested) tree.subdirs.push(nested);
      continue;
    }
    if (isNoiseFile(e.name)) continue;
    tree.files.push(e.name);
  }
  return tree;
}

/**
 * Отпечаток дерева: mtime каждого каталога и имена файлов. Любое появление,
 * удаление или переименование файла меняет mtime его каталога — отпечаток
 * ловит всё, кроме перезаписи файла на месте под тем же именем (NTFS mtime
 * каталога при этом не трогает). Dropbox и Photoshop пишут через временный
 * файл и переименование, так что на практике это редкость; цена — событие
 * «отгрузку переписали» в таком случае появится только со следующим
 * изменением в папке.
 */
function treeStamp(tree: DirTree): string {
  const h = createHash('sha1');
  const walk = (t: DirTree) => {
    h.update(String(t.mtimeMs)).update('\0').update(t.files.join('\n')).update('\0');
    for (const s of t.subdirs) walk(s);
  };
  walk(tree);
  return h.digest('hex');
}

/** Считает файлы, самый свежий mtime и обложку — stat на каждый файл. */
function summarizeTree(tree: DirTree): FolderSummary {
  const out: FolderSummary = { fileCount: 0, newest: null, coverPath: null, coverAt: null };

  for (const nested of tree.subdirs.map(summarizeTree)) {
    out.fileCount += nested.fileCount;
    if (nested.newest && (!out.newest || nested.newest > out.newest)) out.newest = nested.newest;
    if (nested.coverAt && (!out.coverAt || nested.coverAt > out.coverAt)) {
      out.coverAt = nested.coverAt;
      out.coverPath = nested.coverPath;
    }
  }

  for (const name of tree.files) {
    const full = path.join(tree.dir, name);
    out.fileCount++;
    try {
      const stat = scanFs().stat(full);
      if (!out.newest || stat.mtime > out.newest) out.newest = stat.mtime;
      if (isImage(name) && stat.size >= CONFIG.minFileSize) {
        if (!out.coverAt || stat.mtime > out.coverAt) {
          out.coverAt = stat.mtime;
          out.coverPath = full;
        }
      }
    } catch {
      /* файл исчез между readdir и stat */
    }
  }

  return out;
}

/** Даты в кеше лежат числами */
interface StoredSummary {
  fileCount: number;
  newest: number | null;
  coverPath: string | null;
  coverAt: number | null;
}

/**
 * Сводка папки отгрузки. Это 70 % всех обращений к диску за скан: каждая
 * отгрузка — сотни файлов, и все они статятся ради max(mtime). Поэтому
 * результат кешируется по отпечатку дерева, а stat файлов идёт только
 * когда в папке что-то изменилось.
 */
function summarizeDelivery(dir: string, cache: ScanCache): FolderSummary {
  const tree = readTree(dir);
  if (!tree) return { fileCount: 0, newest: null, coverPath: null, coverAt: null };

  const key = 'outbox:' + dir;
  const stamp = treeStamp(tree);
  const hit = cache.get<StoredSummary>(key, stamp);
  if (hit) {
    return {
      fileCount: hit.fileCount,
      newest: hit.newest === null ? null : new Date(hit.newest),
      coverPath: hit.coverPath,
      coverAt: hit.coverAt === null ? null : new Date(hit.coverAt),
    };
  }

  const out = summarizeTree(tree);
  cache.set<StoredSummary>(key, stamp, {
    fileCount: out.fileCount,
    newest: out.newest?.getTime() ?? null,
    coverPath: out.coverPath,
    coverAt: out.coverAt?.getTime() ?? null,
  });
  return out;
}

interface ImageScan {
  count: number;
  /** имена засчитанных файлов — по ним сверяемся с планом из таблицы клиента */
  names: string[];
  newest: Date | null;
  coverPath: string | null;
  /** файлы с рендерным расширением, не прошедшие порог размера */
  rejected: number;
  /** подпапки — этапы рендера; отдаём отсюда, чтобы не читать каталог второй раз */
  dirs: string[];
}

/**
 * Считает рендеры ТОЛЬКО в корне переданной папки, без захода внутрь.
 *
 * Так устроена конвенция студии: текущий рендер сцены лежит плоско, а
 * подпапки 001/002/003 — это предыдущие этапы. Их содержимое показываем
 * в развороте карточки, но в прогресс «X из Y» не добавляем, иначе одна
 * сцена с восемью итерациями весит как восемь сцен.
 */
function scanImages(dir: string): ImageScan {
  const out: ImageScan = { count: 0, names: [], newest: null, coverPath: null, rejected: 0, dirs: [] };

  for (const e of listEntries(dir)) {
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      out.dirs.push(e.name);
      continue;
    }
    if (isNoiseFile(e.name) || !isImage(e.name)) continue;

    let stat: ScanStat;
    try {
      stat = scanFs().stat(full);
    } catch {
      continue;
    }

    if (stat.size < CONFIG.minFileSize) {
      out.rejected++;
      continue;
    }

    out.count++;
    out.names.push(e.name);
    if (!out.newest || stat.mtime > out.newest) {
      out.newest = stat.mtime;
      out.coverPath = full;
    }
  }

  return out;
}

/**
 * Файлы постобработки в КОРНЕ папки сцены — то же правило, что и для JPG.
 *
 * Внутри лежат подпапки этапов: у Scene_1 это «01 02 03 04», у Studio ещё
 * и «BB», «SFACB», «JPEG». Складывать их вместе бессмысленно: получалось
 * «PSD 126» при 16 готовых картинках, потому что суммировались все прошлые
 * проходы. Этапы возвращаем отдельно, как versions у JPG.
 */
function countPsd(dir: string): {
  count: number;
  newest: Date | null;
  stages: SceneVersion[];
} {
  let entries: ScanEntry[];
  try {
    entries = scanFs().readdir(dir);
  } catch {
    return { count: 0, newest: null, stages: [] };
  }
  let count = 0;
  let newest: Date | null = null;
  const stages: SceneVersion[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = countPsdFlat(full);
      if (nested > 0) stages.push({ name: e.name, imageCount: nested });
      continue;
    }
    if (!/\.psd$/i.test(e.name)) continue;
    count++;
    try {
      const m = scanFs().stat(full).mtime;
      if (!newest || m > newest) newest = m;
    } catch {
      /* файл исчез между readdir и stat */
    }
  }
  return { count, newest, stages };
}

/** Сколько psd лежит внутри подпапки-этапа — только для показа, не для прогресса */
function countPsdFlat(dir: string): number {
  return listEntries(dir).filter((e) => !e.isDirectory() && /\.psd$/i.test(e.name)).length;
}

/**
 * Сколько картинок в подпапке-этапе (001, 002…). Только для показа, поэтому
 * без stat и порога размера: этапов на дереве больше тысячи файлов, и статить
 * их ради числа в подсказке — 10 % всех обращений к диску за скан.
 */
function countImagesFlat(dir: string): number {
  return listEntries(dir).filter((e) => !e.isDirectory() && !isNoiseFile(e.name) && isImage(e.name)).length;
}

/** Суммарный вес папки. Дорого (полный обход) — только для отчёта по месту. */
function folderSize(dir: string): number {
  let total = 0;
  let entries: ScanEntry[];
  try {
    entries = scanFs().readdir(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += folderSize(full);
    else {
      try {
        total += scanFs().stat(full).size;
      } catch {
        /* пропускаем */
      }
    }
  }
  return total;
}

export function scanProject(
  root: string,
  folderName: string,
  withSizes = false,
  cache: ScanCache = NO_CACHE,
): ScannedProject {
  const projectPath = path.join(root, folderName);
  const { jobNumber, title } = parseProjectName(folderName);
  const anomalies: Localized[] = [];

  if (jobNumber === null) anomalies.push({ code: 'anomaly.projectNamePattern' });
  if (/\s/.test(folderName)) anomalies.push({ code: 'anomaly.spacesInName' });
  if (/[’']/.test(folderName)) anomalies.push({ code: 'anomaly.apostrophe' });
  if (/[()+]/.test(folderName)) anomalies.push({ code: 'anomaly.bracketsOrPlus' });
  if (/_\s|\s_/.test(folderName)) anomalies.push({ code: 'anomaly.straySpace' });

  const present = new Set(listDirs(projectPath));
  const missingFolders = CONFIG.standardFolders.filter((f) => !present.has(f));

  // ── 05_Outbox: отгрузки клиенту
  const deliveries: ScannedDelivery[] = [];
  const outboxPath = path.join(projectPath, '05_Outbox');
  for (const name of listDirs(outboxPath)) {
    const parsed = parseDelivery(name, folderName);
    const { fileCount, newest, coverPath, coverAt } = summarizeDelivery(path.join(outboxPath, name), cache);
    deliveries.push({
      folderName: name,
      kind: parsed.kind,
      round: parsed.round,
      isJunk: parsed.isJunk,
      fileCount,
      sentAt: fileCount > 0 ? newest : null,
      coverPath,
      coverAt,
    });
    if (!parsed.kind && !parsed.isJunk && fileCount > 0) {
      anomalies.push({ code: 'anomaly.outboxUnknown', params: { name } });
    }
    if (parsed.kind && fileCount === 0) {
      anomalies.push({ code: 'anomaly.outboxEmpty', params: { name } });
    }
  }

  // ── Сцены: перечисляем объединение 04_JPG и 04_EXR.
  // Сцена может существовать только в EXR — рендер уже посчитан фермой,
  // но человек ещё не сконвертировал его в JPG. Такую сцену терять нельзя.
  const scenes: ScannedScene[] = [];
  /** имена реальных файлов по сценам — основа сверки с планом */
  const namesByScene = new Map<string, string[]>();
  const jpgPath = path.join(projectPath, '04_JPG');
  const exrPath = path.join(projectPath, '04_EXR');
  const psdPath = path.join(projectPath, '04_PSD');
  const psdDirs = listDirs(psdPath);
  const sceneNames = [...new Set([...listDirs(jpgPath), ...listDirs(exrPath)])].sort();

  // Привязка папок 04_PSD к сценам. Имена там гуляют: то полное имя сцены,
  // то короткий хвост — «02» вместо Scene_2, «B» вместо Scene_B.
  const psdForScene = new Map<string, string>();
  const usedPsd = new Set<string>();
  for (const name of sceneNames) {
    if (psdDirs.includes(name)) {
      psdForScene.set(name, name);
      usedPsd.add(name);
      continue;
    }
    const suffix = sceneSuffix(name);
    if (!suffix) continue;
    const hit = psdDirs.find((d) => !usedPsd.has(d) && normalizeShortName(d) === suffix);
    if (hit) {
      psdForScene.set(name, hit);
      usedPsd.add(hit);
    }
  }
  // Папки PSD без пары становятся самостоятельными сценами: после сдачи проекта
  // JPG и EXR вычищают ради места, и PSD остаётся единственным следом структуры.
  for (const d of psdDirs) {
    if (usedPsd.has(d)) continue;
    sceneNames.push(d);
    psdForScene.set(d, d);
  }
  sceneNames.sort();

  if (sceneNames.length > 0) {
    for (const name of sceneNames) {
      const scenePath = path.join(jpgPath, name);
      const parsed = parseSceneName(name);
      const img = scanImages(scenePath);
      const exr = scanImages(path.join(exrPath, name));
      const psdFolder = psdForScene.get(name) ?? null;
      const psd = psdFolder
        ? countPsd(path.join(psdPath, psdFolder))
        : { count: 0, newest: null, stages: [] as SceneVersion[] };

      const versionNames = sortVersions(img.dirs.filter((v) => /^\d{1,3}$/.test(v)));
      const versions = versionNames.map((v) => ({
        name: v,
        imageCount: countImagesFlat(path.join(scenePath, v)),
      }));
      const odd = img.dirs.filter((v) => !/^\d{1,3}$/.test(v));

      const skuOptional = (CONFIG.sceneNamesWithoutSku as readonly string[]).includes(
        name.toLowerCase().trim(),
      );
      if (!parsed.isService && !skuOptional && parsed.skus.length === 0) {
        anomalies.push({ code: 'anomaly.sceneNoSku', params: { name } });
      }
      if (odd.length > 0) {
        anomalies.push({ code: 'anomaly.sceneOddSubfolders', params: { name, list: odd.join(', ') } });
      }
      if (img.count === 0 && img.rejected > 0) {
        anomalies.push({ code: 'anomaly.sceneRejectedFiles', params: { name, count: img.rejected } });
      }

      namesByScene.set(name, img.names);

      scenes.push({
        name,
        skus: parsed.skus,
        sceneNumber: parsed.sceneNumber,
        isService: parsed.isService,
        imageCount: img.count,
        exrCount: exr.count,
        lastExrAt: exr.newest,
        psdCount: psd.count,
        lastPsdAt: psd.newest,
        psdStages: psd.stages,
        psdFolder,
        plannedTotal: 0,
        plannedMatched: 0,
        plannedMissing: [],
        plannedGroups: [],
        phase:
          psd.count > 0
            ? 'POST'
            : img.count > 0
              ? 'CONVERTED'
              : exr.count > 0
                ? 'RENDERING'
                : 'EMPTY',
        versions,
        lastImageAt: img.newest,
        coverPath: img.coverPath,
        hasUnrecognizedFiles: img.count === 0 && img.rejected > 0,
      });
    }
  }

  // ── 01_Clients читаем один раз: и план рендеров, и сигналы правок от клиента
  const clientsPath = path.join(projectPath, '01_Clients');
  const clientEntries = listEntries(clientsPath);

  const planFile = findPlanFile(clientsPath, clientEntries);
  const plans: Map<string, ScenePlan> = planFile
    ? assignPlans(parsePlan(planFile, cache), namesByScene)
    : new Map();

  for (const scene of scenes) {
    const plan = plans.get(scene.name);
    if (!plan) continue;
    scene.plannedTotal = plan.total;
    scene.plannedMatched = plan.matched;
    scene.plannedMissing = plan.missing;
    scene.plannedGroups = plan.groups;
  }

  const clientFeedbackFolders = clientEntries
    .filter((e) => e.isDirectory() && /comment|feedback|correction|post_ref/i.test(e.name))
    .map((e) => e.name);

  return {
    key: projectKey(folderName),
    folderName,
    path: projectPath,
    jobNumber,
    title,
    hasStandardStructure: missingFolders.length === 0,
    missingFolders,
    deliveries,
    scenes,
    clientFeedbackFolders,
    anomalies,
    sizeBytes: withSizes ? folderSize(projectPath) : null,
  };
}

export function listProjectFolders(root: string): string[] {
  return listDirs(root)
    .filter((n) => /^Kraus[_\s]/i.test(n))
    .filter((n) => !(CONFIG.notProjects as readonly string[]).includes(n));
}

export function scanAll(
  root: string = CONFIG.root,
  withSizes = false,
  cache: ScanCache = NO_CACHE,
): ScannedProject[] {
  if (!exists(root)) throw new Error(`Корень Dropbox не найден: ${root}`);
  return listProjectFolders(root).map((name) => scanProject(root, name, withSizes, cache));
}
