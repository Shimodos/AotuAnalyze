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
 */
export function findPlanFile(clientsDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(clientsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((e) => !e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /_render_tasks.*\.xlsx?$/i.test(name))
    .filter((name) => !/^~\$/.test(name))
    .filter((name) => !/(спірна|спорная|конфликт|conflicted|копія|копия|copy)/i.test(name));

  if (candidates.length === 0) return null;
  // При нескольких берём самый свежий — таблицу обновляют, а старую иногда оставляют
  candidates.sort((a, b) => {
    const at = (n: string) => {
      try {
        return fs.statSync(path.join(clientsDir, n)).mtimeMs;
      } catch {
        return 0;
      }
    };
    return at(b) - at(a);
  });
  return path.join(clientsDir, candidates[0]);
}

/** Кеш по пути и времени изменения: таблицу незачем перечитывать на каждом скане */
const cache = new Map<string, { mtimeMs: number; groups: PlanGroup[] }>();

export function parsePlan(filePath: string): PlanGroup[] {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return [];
  }

  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.groups;

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
  cache.set(filePath, { mtimeMs, groups: filled });
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
