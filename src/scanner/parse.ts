/**
 * Парсеры имён папок. Все фиксы из аудита analyze.ts живут здесь.
 */

import { CONFIG, type DeliveryKind } from '@/config';

/** Нижний регистр, апострофы прочь, пробелы/дефисы -> подчёркивание */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/** Kraus_211_Gold_Finish_Refresh -> { jobNumber: 211, title: 'Gold Finish Refresh' } */
export function parseProjectName(folderName: string): { jobNumber: number | null; title: string } {
  const m = folderName.match(/^Kraus[_\s]+(\d{2,4})[_\s]+(.+)$/i);
  if (!m) return { jobNumber: null, title: folderName };
  return {
    jobNumber: parseInt(m[1], 10),
    title: m[2].replace(/_+/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Стабильный ключ проекта. Номер джоба переживает переименование названия —
 * это локальный аналог dropbox file_id из PROJECT.md §7.
 */
export function projectKey(folderName: string): string {
  const { jobNumber } = parseProjectName(folderName);
  return jobNumber !== null ? `job:${jobNumber}` : `name:${normalize(folderName)}`;
}

export interface ParsedDelivery {
  kind: DeliveryKind | null;
  round: number | null;
  isJunk: boolean;
}

/**
 * Разбор имени папки в 05_Outbox.
 *
 * Порядок проверки суффиксов важен: prefinal до final, fast_preview до preview,
 * иначе Prefinal читается как Final, а Fast_Preview как Preview.
 */
export function parseDelivery(folderName: string, projectFolder: string): ParsedDelivery {
  let s = normalize(folderName);
  const proj = normalize(projectFolder);

  // отрезаем префикс имени проекта, если он есть
  if (s.startsWith(proj)) s = s.slice(proj.length);
  // сначала 'kraus_', потом номер джоба — иначе из 'kraus_211_...' номер не срежется
  s = s.replace(/^_+/, '').replace(/^kraus_/, '').replace(/^_?\d{2,4}_/, '').replace(/^_+/, '');

  // ФИКС: сравнение по токенам, а не по подстроке.
  // Подстрочное includes('old') помечало мусором «Bolden» и «Gold».
  const isJunk = s.split('_').some((t) => (CONFIG.outboxJunkMarkers as readonly string[]).includes(t));

  let kind: DeliveryKind | null = null;
  if (/prefinal/.test(s)) kind = 'PREFINAL';
  else if (/fast_?previews?/.test(s)) kind = 'FAST_PREVIEW';
  else if (/final/.test(s)) kind = 'FINAL';
  else if (/previews?/.test(s)) kind = 'PREVIEW';

  // круг правок: хвостовые цифры (_01, _1, _001, ' 2')
  const roundMatch = s.match(/[_\s](\d{1,3})$/);
  const round = roundMatch ? parseInt(roundMatch[1], 10) : null;

  return { kind, round, isJunk };
}

export interface ParsedScene {
  skus: string[];
  sceneNumber: string | null;
  isService: boolean;
}

/**
 * KHT632-33-C_KPF-1610SFS-DP02-C_Scene_2
 *   -> skus: [KHT632-33-C, KPF-1610SFS-DP02-C], sceneNumber: '2'
 */
export function parseSceneName(name: string): ParsedScene {
  const flat = normalize(name).replace(/_/g, ' ');
  const isService =
    (CONFIG.serviceSceneNames as readonly string[]).includes(flat) ||
    (CONFIG.serviceSceneNames as readonly string[]).includes(name.toLowerCase().trim());

  const sceneMatch = name.match(/(?:scene|angle)[_\s]?(\d{1,3})/i);
  const sceneNumber = sceneMatch ? sceneMatch[1] : null;

  // Универсальный шаблон артикула вместо белого списка префиксов:
  // реальные данные содержат FF-104BB, WFDP-06SFS, KGUW2-33MBL, KFR1-33GWH,
  // которых в списке PROJECT.md §4 нет.
  const skus = (name.match(/\b[A-Z]{2,4}[0-9]?[-_]?\d{2,4}[A-Z0-9-]*/g) ?? []).filter(
    (t) => !/^(scene|angle)/i.test(t),
  );

  return { skus, sceneNumber, isService };
}

/** Сортировка версий по числу, а не лексикографически: ['001','01','002'] -> максимум '002' */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

export function isImage(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return (CONFIG.imageExtensions as readonly string[]).includes(ext);
}

export function isNoiseFile(fileName: string): boolean {
  return fileName.startsWith('.') || fileName === 'Thumbs.db' || fileName === 'desktop.ini';
}

/**
 * Кириллические двойники латинских букв. В 04_PSD у Kraus_214 папка названа
 * кириллической «С», а сцена — латинской «Scene_C». Глазами не отличить,
 * для программы это разные символы.
 */
const LOOKALIKES: Record<string, string> = {
  А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M',
  О: 'O', Р: 'P', Т: 'T', Х: 'X', а: 'a', в: 'b', с: 'c',
  е: 'e', о: 'o', р: 'p', х: 'x',
};

export function latinize(value: string): string {
  return value.replace(/[А-Яа-я]/g, (ch) => LOOKALIKES[ch] ?? ch);
}

/**
 * Хвост имени сцены: номер или буква после Scene/Angle.
 * KPF-1616BB_..._Scene_2 -> '2',  ..._Scene_B -> 'b',  ..._Scene03 -> '3'
 *
 * Нужен, чтобы привязать к сцене папку в 04_PSD, названную коротко —
 * там встречаются «02», «B», «D» вместо полного имени.
 */
export function sceneSuffix(name: string): string | null {
  const m = latinize(name).match(/(?:scene|angle)[_\s]?([a-z0-9]{1,3})\s*$/i);
  if (!m) return null;
  return normalizeShortName(m[1]);
}

/**
 * Приводит короткое имя PSD-папки к тому же виду, что и хвост сцены.
 * Ведущие нули срезаем: папка «02» и сцена «Scene_2» — одно и то же.
 */
export function normalizeShortName(name: string): string {
  return latinize(name)
    .trim()
    .toLowerCase()
    .replace(/^0+(?=\d)/, '');
}
