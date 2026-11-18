/**
 * Скан проектов по индексу Dropbox — тот же scanAll, что и у обхода диска,
 * только файловая система подменена (docs/PLAN-DROPBOX-API.md, этап 2).
 *
 * Единственное, чего в индексе нет, — содержимое файлов. Сканеру оно нужно
 * в одном месте: xlsx-план клиента. Поэтому перед сканом планы скачиваются
 * через API и кладутся в кеш; сам скан остаётся синхронным и в сеть не ходит.
 */

import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { CONFIG } from '@/config';
import { dropboxContent } from '@/dropbox/content';
import type { ScanCache } from '@/scanner/cache';
import { withScanFs } from '@/scanner/fs';
import { findPlanFile, parseWorkbook, planCacheRef, type PlanGroup } from '@/scanner/plan';
import { scanAll, type ScannedProject } from '@/scanner/scan';
import { SqliteCache } from '@/sync/cache';
import { createIndexFs, type IndexFs } from './fs';

/**
 * Кеш для скана по индексу: пропускает только планы и держит их под своим
 * ключом. Сводки отгрузок не кешируем — в памяти они считаются мгновенно,
 * а их отпечаток строится на датах каталогов, которых у Dropbox нет. Свой
 * ключ нужен, чтобы не затирать записи дискового скана: отпечаток там другой
 * (дата с долями секунды), и два источника выбивали бы кеш друг другу.
 */
function apiCache(inner: ScanCache): ScanCache {
  const own = (key: string) => (key.startsWith('plan:') ? 'api:' + key : null);
  return {
    get<T>(key: string, stamp: string): T | null {
      const k = own(key);
      return k ? inner.get<T>(k, stamp) : null;
    },
    set<T>(key: string, stamp: string, value: T): void {
      const k = own(key);
      if (k) inner.set(k, stamp, value);
    },
  };
}

async function download(dropboxPath: string): Promise<Buffer> {
  const res = await dropboxContent('files/download', { path: dropboxPath });
  if (!res.ok) throw new Error(`Dropbox files/download: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface PlanFetchResult {
  /** планы, скачанные за этот проход (остальные взяты из кеша) */
  downloaded: number;
  failed: string[];
}

/** Скачать планы, которых нет в кеше или которые изменились */
async function fetchPlans(io: IndexFs, cache: SqliteCache, root: string): Promise<PlanFetchResult> {
  const result: PlanFetchResult = { downloaded: 0, failed: [] };
  const scoped = apiCache(cache);

  for (const folder of io.projectFolders()) {
    const planFile = withScanFs(io, () => findPlanFile(path.join(root, folder, '01_Clients')));
    if (!planFile) continue;
    const ref = withScanFs(io, () => planCacheRef(planFile));
    if (!ref || scoped.get<PlanGroup[]>(ref.key, ref.stamp)) continue;

    const remote = io.dropboxPath(planFile);
    if (!remote) continue;
    try {
      const workbook = XLSX.read(await download(remote), { type: 'buffer' });
      scoped.set(ref.key, ref.stamp, parseWorkbook(workbook));
      result.downloaded++;
    } catch (error) {
      // Без плана проект просто считается по сценам — как если бы таблицы не было
      result.failed.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  cache.flush();
  return result;
}

export interface IndexScan {
  projects: ScannedProject[];
  plans: PlanFetchResult;
}

/** Скан всех загруженных отслеживаемых проектов по индексу. Диск не читается. */
export async function scanFromIndex(root: string = CONFIG.root): Promise<IndexScan> {
  const io = createIndexFs(root);
  const cache = new SqliteCache();
  const plans = await fetchPlans(io, cache, root);
  const projects = withScanFs(io, () => scanAll(root, false, apiCache(cache)));
  return { projects, plans };
}
