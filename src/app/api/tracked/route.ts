import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { isConnected } from '@/dropbox/tokens';
import {
  indexSummary,
  isRemoteSyncRunning,
  listRootProjects,
  seedTrackedFromProjects,
  syncRemoteInBackground,
} from '@/remote';
import { parseProjectName } from '@/scanner/parse';
import { errorMessage, jsonError, readJson, requireSameOrigin } from '@/server/http';

export const dynamic = 'force-dynamic';

export interface TrackedItem {
  key: string;
  folderName: string;
  jobNumber: number | null;
  title: string;
  tracked: boolean;
  /** дерево проекта уже лежит в индексе */
  synced: boolean;
  files: number;
  /** папка есть в корне Dropbox; false — отслеживаем то, чего уже нет */
  inRoot: boolean;
  /** не отслеживается и новее всех отслеживаемых — скорее всего, свежий проект */
  isNew: boolean;
}

export interface TrackedData {
  items: TrackedItem[];
  trackedCount: number;
  /** индекс прямо сейчас подтягивается — список стоит опросить ещё раз */
  syncing: boolean;
}

/**
 * Список папок проектов из корня Dropbox и то, за какими из них следит трекер.
 * Один нерекурсивный запрос к API; диск не трогается.
 */
export async function GET() {
  if (!isConnected()) return jsonError('Dropbox не подключён', 409, 'not-connected');

  try {
    seedTrackedFromProjects();
    const inRoot = await listRootProjects();
    const summary = new Map(indexSummary().map((p) => [p.key, p] as const));

    const items: TrackedItem[] = [];
    const build = (key: string, folderName: string, present: boolean): TrackedItem => {
      const { jobNumber, title } = parseProjectName(folderName);
      const index = summary.get(key);
      return {
        key,
        folderName,
        jobNumber,
        title,
        tracked: index !== undefined,
        synced: index?.synced ?? false,
        files: index?.files ?? 0,
        inRoot: present,
        isNew: false,
      };
    };

    for (const [key, folderName] of inRoot) items.push(build(key, folderName, true));
    for (const [key, p] of summary) {
      if (!inRoot.has(key)) items.push(build(key, p.folderName, false));
    }

    const newestTracked = Math.max(0, ...items.filter((i) => i.tracked).map((i) => i.jobNumber ?? 0));
    for (const item of items) {
      item.isNew = !item.tracked && item.jobNumber !== null && item.jobNumber > newestTracked;
    }

    items.sort((a, b) => (b.jobNumber ?? -1) - (a.jobNumber ?? -1) || a.folderName.localeCompare(b.folderName));

    const data: TrackedData = {
      items,
      trackedCount: items.filter((i) => i.tracked).length,
      syncing: isRemoteSyncRunning(),
    };
    return NextResponse.json(data);
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}

interface ToggleBody {
  key?: string;
  tracked?: boolean;
}

/**
 * Начать или перестать следить за проектом.
 *
 * Добавление только помечает проект: дерево подтягивается следом, в фоне.
 * Снятие убирает проект из списка и его записи из индекса; карточку, историю
 * переходов, пины и чеклисты не трогает.
 */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const body = await readJson<ToggleBody>(request);
  if (!body || typeof body.key !== 'string' || typeof body.tracked !== 'boolean') {
    return jsonError('нужны key и tracked', 400);
  }
  if (!isConnected()) return jsonError('Dropbox не подключён', 409, 'not-connected');

  try {
    const db = getDb();
    const { key } = body;

    if (!body.tracked) {
      db.transaction((tx) => {
        tx.delete(schema.remoteEntries).where(eq(schema.remoteEntries.projectKey, key)).run();
        tx.delete(schema.trackedProjects).where(eq(schema.trackedProjects.key, key)).run();
      });
      return NextResponse.json({ ok: true });
    }

    // Ключ из запроса — только тот, что реально есть в корне: имя папки берём
    // у Dropbox, а не у клиента
    const folderName = (await listRootProjects()).get(key);
    if (!folderName) return jsonError('такой папки нет в корне Dropbox', 404, 'not-in-root');

    db.insert(schema.trackedProjects)
      .values({ key, folderName, addedAt: new Date(), syncedAt: null })
      .onConflictDoNothing()
      .run();

    syncRemoteInBackground();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(errorMessage(error), 502);
  }
}
