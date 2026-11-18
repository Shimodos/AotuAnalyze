/**
 * Запись чеклиста правок в текстовый файл рядом с кадрами.
 *
 * Это ЕДИНСТВЕННОЕ место, где приложение пишет в Dropbox. Всё остальное —
 * только чтение. Поэтому здесь стоит белый список: путь обязан оказаться
 * ровно в <корень>/<проект>/04_JPG/<сцена>/ и файл обязан называться ровно
 * так, как мы задали. Ничего не создаём, ничего не удаляем.
 *
 * Файл — зеркало базы, а не источник правды: приложение его пишет и никогда
 * не читает обратно. Правка руками в «Блокноте» потеряется при следующем
 * сохранении, поэтому об этом сказано в самом файле.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from '@/config';
import { isInsideRoot, isSafeSegment, scenePath } from '@/server/paths';
import { rootDir } from '@/server/root';

/** Латиница намеренно: имя попадает в путь, синхронизацию и чужие инструменты */
export const REVISIONS_FILE = '_Revisions.txt';

export interface RevisionItem {
  fileName: string;
  isDone: boolean;
  note: string | null;
  /** файла с таким именем на диске уже нет, но отметка осталась */
  isOrphan?: boolean;
}

export interface RevisionsDoc {
  projectFolder: string;
  sceneName: string;
  round: number;
  items: RevisionItem[];
}

/**
 * Путь к файлу чеклиста. Возвращает null, если путь хоть чем-то отличается
 * от разрешённого — лучше не записать, чем записать не туда.
 */
export function revisionsFilePath(projectPath: string, sceneName: string): string | null {
  // Имя сцены приходит из запроса, поэтому разделители пути в нём недопустимы:
  // иначе «../../..» увёл бы запись за пределы проекта
  if (!isSafeSegment(sceneName)) return null;

  const project = path.resolve(projectPath);
  if (!isInsideRoot(project)) return null;

  const sceneDir = path.resolve(scenePath(project, sceneName));
  const target = path.resolve(sceneDir, REVISIONS_FILE);

  // Повторная проверка уже собранного пути: единственный способ убедиться,
  // что ни один сегмент не увёл нас в сторону
  if (path.dirname(target) !== sceneDir) return null;
  if (path.basename(target) !== REVISIONS_FILE) return null;
  if (!isInsideRoot(target) || target === path.resolve(rootDir())) return null;

  return target;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function stamp(d: Date): string {
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Человекочитаемый текст. Ширина рассчитана на «Блокнот» без переноса строк. */
export function renderRevisions(doc: RevisionsDoc): string {
  const done = doc.items.filter((i) => i.isDone).length;
  const lines: string[] = [];

  lines.push('ПРАВКИ · ' + doc.projectFolder);
  lines.push('Сцена: ' + doc.sceneName);
  lines.push(`Круг ${doc.round} · обновлено ${stamp(new Date())} · внесено ${done} из ${doc.items.length}`);
  lines.push('');

  for (const item of doc.items) {
    lines.push(`${item.isDone ? '[x]' : '[ ]'} ${item.fileName}${item.isOrphan ? '   (файла нет на диске)' : ''}`);
    if (item.note) {
      // Заметка может быть многострочной — выравниваем каждую строку
      for (const line of item.note.split(/\r?\n/)) lines.push('    ' + line);
    }
  }

  if (doc.items.length === 0) lines.push('(в папке сцены нет кадров)');

  lines.push('');
  lines.push('— файл создаётся Viarde Tracker; правки, внесённые сюда руками, будут перезаписаны —');

  // CRLF и BOM: без них «Блокнот» показывает весь текст одной строкой
  // и ломает кириллицу
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export interface WriteResult {
  ok: boolean;
  path?: string;
  reason?: string;
  /** на диске уже ровно это — файл не трогали, Dropbox не будили */
  unchanged?: boolean;
  /** запись отложена на несколько секунд, последняя версия допишется сама */
  deferred?: boolean;
}

/**
 * Метка времени в заголовке — единственное, что меняется от рендера к рендеру
 * при одном и том же чеклисте. Сравниваем без неё, иначе каждая галочка,
 * поставленная и снятая обратно, уезжала бы в Dropbox новой ревизией.
 */
const STAMP_RE = / · обновлено \d\d\.\d\d\.\d{4} \d\d:\d\d/;

function sameContent(a: string, b: string): boolean {
  return a.replace(STAMP_RE, '') === b.replace(STAMP_RE, '');
}

/**
 * Файл лежит в Dropbox, и каждая запись — это ревизия и выгрузка в облако.
 * Заметка набирается с паузами по 700 мс, и без этого порога одна фраза
 * превращалась бы в пять-шесть выгрузок. База обновляется сразу, файл —
 * не чаще раза в пять секунд, последней версией.
 */
const MIN_WRITE_INTERVAL_MS = 5_000;
const lastWriteAt = new Map<string, number>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; text: string }>();

function writeNow(target: string, text: string): WriteResult {
  try {
    fs.writeFileSync(target, text, 'utf8');
    lastWriteAt.set(target, Date.now());
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function cancelPending(target: string) {
  const p = pending.get(target);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(target);
}

function schedule(target: string, text: string, delayMs: number) {
  const existing = pending.get(target);
  if (existing) {
    // таймер уже заведён — только подменяем содержимое на более свежее
    existing.text = text;
    return;
  }
  const timer = setTimeout(() => {
    const p = pending.get(target);
    pending.delete(target);
    if (!p) return;
    const res = writeNow(target, p.text);
    if (!res.ok) console.error(`[tracker] отложенная запись ${REVISIONS_FILE} не удалась:`, res.reason);
  }, delayMs);
  // не держим процесс живым только ради таймера
  timer.unref?.();
  pending.set(target, { timer, text });
}

/**
 * Записывает файл. Папку не создаёт: если её нет, значит сцену переименовали
 * или удалили, и создавать её мы права не имеем.
 */
export function writeRevisionsFile(
  projectPath: string,
  doc: RevisionsDoc,
): WriteResult {
  if (!CONFIG.writeRevisionsFile) return { ok: false, reason: 'disabled' };

  const target = revisionsFilePath(projectPath, doc.sceneName);
  if (!target) return { ok: false, reason: 'forbidden' };

  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) return { ok: false, reason: 'no-scene-folder' };

  const text = renderRevisions(doc);

  // Если по этому имени вдруг оказалась папка — не трогаем
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
    if (sameContent(fs.readFileSync(target, 'utf8'), text)) {
      // на диске уже актуальная версия — отложенная запись, если была, не нужна
      cancelPending(target);
      return { ok: true, path: target, unchanged: true };
    }
  } catch {
    /* файла ещё нет — это норма */
  }

  const sinceLast = Date.now() - (lastWriteAt.get(target) ?? 0);
  if (sinceLast < MIN_WRITE_INTERVAL_MS) {
    schedule(target, text, MIN_WRITE_INTERVAL_MS - sinceLast);
    return { ok: true, path: target, deferred: true };
  }

  return writeNow(target, text);
}
