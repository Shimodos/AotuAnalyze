/**
 * План рендеров из сводной таблицы клиента.
 *
 * В 01_Clients лежит файл вида «Directions - <название>_render_tasks.xlsx».
 * Внутри листы (обычно Interior и Studio) с шапкой
 * «Scene/File | Preview | Prefinal | Final | Errors». Строка — либо заголовок
 * сцены, либо имя ожидаемого файла.
 *
 * Ключевое свойство, на котором всё держится: имена файлов в таблице совпадают
 * с реальными именами рендеров на диске. Поэтому считаем не только «сколько
 * должно быть», но и какие именно кадры уже сделаны, а каких не хватает.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { NO_CACHE, type ScanCache } from './cache';

export interface PlanGroup {
  /** имя листа: Interior, Studio, Render Tasks */
  sheet: string;
  /** заголовок группы: «Scene 3 BB - 15 SFACB» либо имя листа, если заголовков нет */
  label: string;
  files: string[];
}

export interface ScenePlan {
  total: number;
  /** сколько кадров плана нашлось на диске по точному имени файла */
  matched: number;
  /** имена из плана, которых на диске нет — не больше 40, длинные списки бесполезны */
  missing: string[];
  /**
   * Заголовки групп таблицы, отнесённых к этой сцене. Обычно один, но у 214
   * к папке Studio относятся сразу «Studio» и «SSI» — без этого списка
   * непонятно, откуда взялось число плана.
   */
  groups: string[];
}

/** Строка таблицы — имя файла рендера, а не заголовок сцены */
function isFileRow(value: string): boolean {
  return /\.(jpg|jpeg|png|tif|tiff|psd)$/i.test(value);
}

/**
 * Ищет таблицу плана. Конфликтные копии Dropbox и временные файлы Excel
 * отсеиваем: «Спірна копія», «копія», префикс ~$.
 *
 * Содержимое каталога можно передать снаружи — сканер читает 01_Clients
 * и для других целей, второй раз ходить на диск незачем.
 */
export function findPlanFile(clientsDir: string, entries?: fs.Dirent[]): string | null {
  if (!entries) {
    try {
      entries = fs.readdirSync(clientsDir, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  const candidates = entries
    .filter((e) => !e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /_render_tasks.*\.xlsx?$/i.test(name))
    .filter((name) => !/^~\$/.test(name))
    .filter((name) => !/(спірна|спорная|конфликт|conflicted|копія|копия|copy)/i.test(name));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return path.join(clientsDir, candidates[0]);

  // При нескольких берём самый свежий — таблицу обновляют, а старую иногда
  // оставляют. mtime считаем один раз на кандидата, а не внутри компаратора.
  const mtimeOf = (name: string) => {
    try {
      return fs.statSync(path.join(clientsDir, name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const newest = candidates
    .map((name) => ({ name, at: mtimeOf(name) }))
    .sort((a, b) => b.at - a.at)[0];
  return path.join(clientsDir, newest.name);
}

/**
 * Таблицу незачем перечитывать на каждом скане: разобранные группы кешируются
 * по отпечатку «mtime + размер». Кеш передаёт вызывающий (в сервере — SQLite,
 * потому что скан идёт отдельным процессом и память между сканами не живёт).
 */
export function parsePlan(filePath: string, cache: ScanCache = NO_CACHE): PlanGroup[] {
  let stamp: string;
  try {
    const st = fs.statSync(filePath);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }

  const key = 'plan:' + filePath;
  const hit = cache.get<PlanGroup[]>(key, stamp);
  if (hit) return hit;

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (error) {
    // Молчать здесь нельзя: пустой результат неотличим от «плана нет»,
    // а именно так пряталась поломка xlsx внутри бандла Next.
    console.error(
      '[tracker] не удалось прочитать план',
      path.basename(filePath),
      error instanceof Error ? error.message : error,
    );
    return [];
  }

  const groups: PlanGroup[] = [];

  for (const sheet of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheet], {
      header: 1,
      defval: '',
      blankrows: false,
    });

    // Группу обнуляем на каждом листе. Иначе файлы листа Studio, у которого
    // нет заголовков сцен, приписываются к последней группе листа Interior.
    let current: PlanGroup | null = null;

    for (const row of rows.slice(1)) {
      const value = String(row?.[0] ?? '').trim();
      if (!value) continue;

      if (isFileRow(value)) {
        if (!current) {
          current = { sheet, label: sheet, files: [] };
          groups.push(current);
        }
        current.files.push(value);
      } else {
        current = { sheet, label: value, files: [] };
        groups.push(current);
      }
    }
  }

  const filled = groups.filter((g) => g.files.length > 0);
  cache.set(key, stamp, filled);
  return filled;
}

/**
 * Привязка групп к папкам сцен по фактическому расположению файлов:
 * если большинство кадров группы лежит в папке X, группа относится к X.
 *
 * Так надёжнее, чем сверять названия: заголовки в таблице пишут вольно
 * («Scene 3 BB - 15 SFACB»), а имена папок содержат перечень артикулов.
 */
export function assignPlans(
  groups: PlanGroup[],
  filesByScene: Map<string, string[]>,
): Map<string, ScenePlan> {
  const owner = new Map<string, string>();
  for (const [scene, files] of filesByScene) {
    for (const file of files) owner.set(file.toLowerCase(), scene);
  }

  const result = new Map<string, ScenePlan>();

  for (const group of groups) {
    const votes = new Map<string, number>();
    for (const file of group.files) {
      const scene = owner.get(file.toLowerCase());
      if (scene) votes.set(scene, (votes.get(scene) ?? 0) + 1);
    }

    const winner = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (!winner) continue; // файлов группы на диске нет — привязать не к чему

    const scene = winner[0];
    const missing = group.files.filter((f) => owner.get(f.toLowerCase()) !== scene);
    const previous = result.get(scene);

    // Несколько групп могут указывать на одну папку — складываем
    result.set(scene, {
      total: (previous?.total ?? 0) + group.files.length,
      matched: (previous?.matched ?? 0) + (group.files.length - missing.length),
      missing: [...(previous?.missing ?? []), ...missing].slice(0, 40),
      groups: [...(previous?.groups ?? []), group.label],
    });
  }

  return result;
}
