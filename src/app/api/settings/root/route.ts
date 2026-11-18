import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb, schema } from '@/db';
import { errorMessage, jsonError, readJson, requireSameOrigin } from '@/server/http';
import { rootDir, rootSource, saveRoot, type RootSource } from '@/server/root';
import { startBackgroundScan } from '@/sync/launch';

export const dynamic = 'force-dynamic';

export interface RootData {
  /** локальная папка Dropbox на этой машине */
  path: string;
  /** откуда взят путь; 'env' — задан переменной окружения и с экрана не меняется */
  source: RootSource;
  /** папка существует */
  exists: boolean;
  /** сколько отслеживаемых проектов лежит в этой папке локально */
  localProjects: number;
  trackedProjects: number;
}

/**
 * Проверка папки: существует ли и сколько отслеживаемых проектов в ней есть.
 * По одному запросу на проект, только к самой папке проекта — внутрь не ходим.
 * Проект без локальной копии — не ошибка: доска показывает его по данным API.
 */
function describe(dir: string): RootData {
  let exists = false;
  try {
    exists = fs.statSync(dir).isDirectory();
  } catch {
    /* нет папки или нет диска */
  }

  const tracked = getDb().select({ folderName: schema.trackedProjects.folderName }).from(schema.trackedProjects).all();
  const localProjects = exists ? tracked.filter((p) => fs.existsSync(path.join(dir, p.folderName))).length : 0;

  return { path: dir, source: rootSource(), exists, localProjects, trackedProjects: tracked.length };
}

export async function GET() {
  try {
    return NextResponse.json(describe(rootDir()));
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}

/** Сменить папку. После смены пути проектов в базе пересчитывает скан. */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const body = await readJson<{ path?: string }>(request);
  // Путь часто копируют из проводника вместе с кавычками
  const raw = typeof body?.path === 'string' ? body.path.trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (!raw) return jsonError('укажите путь к папке', 400, 'empty');
  if (!path.isAbsolute(raw)) return jsonError('нужен полный путь, например D:\\Dropbox', 400, 'not-absolute');
  if (rootSource() === 'env') {
    return jsonError('путь задан переменной VIARDE_ROOT и с экрана не меняется', 409, 'env');
  }

  try {
    const dir = path.resolve(raw);
    const info = describe(dir);
    if (!info.exists) return jsonError('такой папки нет', 400, 'not-found');

    saveRoot(dir);
    // Пути проектов и обложек в базе — локальные, от старой папки. Скан их перепишет.
    startBackgroundScan();
    return NextResponse.json(describe(dir));
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}
