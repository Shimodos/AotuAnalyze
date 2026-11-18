import * as nodePath from 'node:path';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { CONFIG } from '@/config';
import { getDb, schema } from '@/db';
import { dropboxPathOf } from '@/dropbox/content';
import { isConnected } from '@/dropbox/tokens';
import { indexDir } from '@/remote';
import { listSceneFrames, mergeChecklist, type ChecklistItem, type StoredMark } from '@/checklist/checklist';
import { writeRevisionsFile, type RevisionItem, type WriteResult } from '@/checklist/file';
import { currentRound } from '@/checklist/round';
import { fileWebUrl } from '@/dropbox/webUrl';
import { errorMessage, jsonError, readJson, requireSameOrigin } from '@/server/http';
import { isSafeSegment, scenePath } from '@/server/paths';

export const dynamic = 'force-dynamic';

/** Заметка к кадру уходит в файл в Dropbox — без предела он раздувался бы произвольно */
const NOTE_MAX_LENGTH = 2000;

/** Ответ GET и тело POST-ответа — один тип, клиент импортирует его отсюда */
export interface ChecklistData {
  projectKey: string;
  sceneName: string;
  round: number;
  /** круги, по которым уже есть отметки, плюс текущий */
  rounds: number[];
  items: ChecklistItem[];
  done: number;
  total: number;
}

type ProjectRow = NonNullable<ReturnType<typeof loadProject>>;

function loadProject(key: string) {
  return getDb().select().from(schema.projects).where(eq(schema.projects.key, key)).get();
}

function marksFor(projectKey: string, sceneName: string, round: number): StoredMark[] {
  return getDb()
    .select()
    .from(schema.sceneChecks)
    .where(
      and(
        eq(schema.sceneChecks.projectKey, projectKey),
        eq(schema.sceneChecks.sceneName, sceneName),
        eq(schema.sceneChecks.round, round),
      ),
    )
    .all()
    .map((r) => ({
      fileName: r.fileName,
      isDone: r.isDone,
      note: r.note,
      updatedAt: r.updatedAt?.getTime() ?? null,
    }));
}

/** Круги, по которым уже есть отметки — чтобы можно было заглянуть в прошлые */
function knownRounds(projectKey: string, sceneName: string): number[] {
  const rows = getDb()
    .select({ round: schema.sceneChecks.round })
    .from(schema.sceneChecks)
    .where(
      and(eq(schema.sceneChecks.projectKey, projectKey), eq(schema.sceneChecks.sceneName, sceneName)),
    )
    .all();
  return [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
}

/** Склейка диска и отметок — одна и та же для чтения и для ответа после записи */
function buildChecklist(project: ProjectRow, scene: string, round: number): ChecklistData {
  const sceneDir = scenePath(project.path, scene);
  // При работе через Dropbox API список кадров берём из индекса: диск не
  // читается. Если индекс про проект не знает — как раньше, с диска.
  const remoteDir = CONFIG.source === 'api' && isConnected() ? dropboxPathOf(sceneDir) : null;
  const fromIndex = remoteDir ? (indexDir(project.key, remoteDir) ?? undefined) : undefined;
  const frames = listSceneFrames(project.path, scene, fromIndex);
  const items = mergeChecklist(frames, marksFor(project.key, scene, round), (name) =>
    fileWebUrl(nodePath.join(sceneDir, name)),
  );
  return {
    projectKey: project.key,
    sceneName: scene,
    round,
    rounds: [...new Set([...knownRounds(project.key, scene), round])].sort((a, b) => a - b),
    items,
    done: items.filter((i) => i.isDone).length,
    total: items.length,
  };
}

/** Круг из запроса: целое ≥ 1, иначе текущий круг проекта */
function pickRound(raw: unknown, project: ProjectRow): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : currentRound(project.round, project.maxRound);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const scene = url.searchParams.get('scene');

  if (!key || !scene) return jsonError('нужны key и scene', 400);
  // Имя сцены попадает в путь на диске — разделители и `..` недопустимы
  if (!isSafeSegment(scene)) return jsonError('некорректное имя сцены', 400);

  try {
    const project = loadProject(key);
    if (!project) return jsonError('проект не найден', 404);

    const round = pickRound(url.searchParams.get('round'), project);
    return NextResponse.json(buildChecklist(project, scene, round));
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}

interface SaveBody {
  key?: string;
  scene?: string;
  round?: number;
  fileName?: string;
  isDone?: boolean;
  note?: string | null;
}

/**
 * Сохранение одной отметки.
 *
 * Порядок важен: сначала база, потом файл. База — источник правды, файл —
 * зеркало для просмотра без приложения. Если запись файла не удалась
 * (папку переименовали, диск отключился), отметка всё равно сохранена,
 * а интерфейс получит причину.
 */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const body = await readJson<SaveBody>(request);
  if (!body) return jsonError('некорректный запрос', 400);

  const { key, scene, fileName } = body;
  if (!key || !scene || !fileName) return jsonError('нужны key, scene и fileName', 400);
  if (!isSafeSegment(scene) || !isSafeSegment(fileName)) {
    return jsonError('некорректное имя сцены или файла', 400);
  }

  try {
    const project = loadProject(key);
    if (!project) return jsonError('проект не найден', 404);

    const round = pickRound(body.round, project);
    const isDone = body.isDone === true;
    const trimmed = typeof body.note === 'string' ? body.note.trim() : '';
    const note = trimmed ? trimmed.slice(0, NOTE_MAX_LENGTH) : null;
    const db = getDb();

    // Пустую отметку не храним: снятая галочка без заметки — это отсутствие
    // записи, иначе таблица растёт мусором от каждого случайного клика
    if (!isDone && !note) {
      db.delete(schema.sceneChecks)
        .where(
          and(
            eq(schema.sceneChecks.projectKey, key),
            eq(schema.sceneChecks.sceneName, scene),
            eq(schema.sceneChecks.round, round),
            eq(schema.sceneChecks.fileName, fileName),
          ),
        )
        .run();
    } else {
      const now = new Date();
      db.insert(schema.sceneChecks)
        .values({ projectKey: key, sceneName: scene, fileName, round, isDone, note, updatedAt: now })
        .onConflictDoUpdate({
          target: [
            schema.sceneChecks.projectKey,
            schema.sceneChecks.sceneName,
            schema.sceneChecks.fileName,
            schema.sceneChecks.round,
          ],
          set: { isDone, note, updatedAt: now },
        })
        .run();
    }

    // Файл переписываем целиком: он маленький, а частичное обновление текста
    // потребовало бы его разбора — то есть ровно того, чего мы избегаем
    const data = buildChecklist(project, scene, round);
    const file: WriteResult = writeRevisionsFile(project.path, {
      projectFolder: project.folderName,
      sceneName: scene,
      round,
      items: data.items.map<RevisionItem>((i) => ({
        fileName: i.fileName,
        isDone: i.isDone,
        note: i.note,
        isOrphan: i.isOrphan,
      })),
    });

    return NextResponse.json({ ...data, file });
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}
