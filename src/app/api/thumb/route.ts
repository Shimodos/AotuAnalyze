import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { desc, eq, isNotNull, and } from 'drizzle-orm';
import sharp from 'sharp';
import { CONFIG } from '@/config';
import { getDb, schema } from '@/db';
import { isImage, isNoiseFile } from '@/scanner/parse';
import { isInsideRoot } from '@/server/paths';

export const dynamic = 'force-dynamic';

const CACHE_DIR = path.join(process.cwd(), CONFIG.thumbCacheDir);

/** Сколько соседних картинок из папки сцены перебираем, если обложки из базы не читаются */
const FOLDER_FALLBACK_LIMIT = 12;

/** Кандидат в обложки: путь и mtime, известные сканеру */
interface Candidate {
  path: string;
  at: Date | null;
}

/**
 * Превью карточки. Оригиналы весят по 4 МБ — отдавать их в сетку нельзя.
 * Ужимаем в webp и кешируем на диск по ключу «путь + mtime», чтобы
 * пересчитывать только при реальной замене рендера.
 *
 * mtime берём из базы (сканер его уже знает), а не stat'ом: обложек на доске
 * тридцать, и тридцать синхронных stat на зависшем USB-диске — это тридцать
 * блокировок сервера при каждой загрузке доски. Попадание в кеш не трогает
 * Dropbox вообще; промах читает файл асинхронно.
 *
 * Обложка проекта — самая свежая картинка. Но самая свежая часто только что
 * пришла с другой машины и лежит онлайн-заглушкой Dropbox: имя и размер есть,
 * содержимого нет, докачать может только работающий клиент. Поэтому если
 * обложка не читается, откатываемся на обложки сцен от свежей к старой —
 * лучше вчерашняя картинка, чем никакой.
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return new NextResponse('key обязателен', { status: 400 });

  const db = getDb();
  const project = db
    .select({ coverPath: schema.projects.coverPath, coverAt: schema.projects.coverAt })
    .from(schema.projects)
    .where(eq(schema.projects.key, key))
    .get();
  if (!project?.coverPath) return new NextResponse('нет обложки', { status: 404 });

  const candidates: Candidate[] = [{ path: project.coverPath, at: project.coverAt }];
  for (const s of db
    .select({ coverPath: schema.scenes.coverPath, lastImageAt: schema.scenes.lastImageAt })
    .from(schema.scenes)
    .where(and(eq(schema.scenes.projectKey, key), isNotNull(schema.scenes.coverPath)))
    .orderBy(desc(schema.scenes.lastImageAt))
    .all()) {
    if (s.coverPath && s.coverPath !== project.coverPath) {
      candidates.push({ path: s.coverPath, at: s.lastImageAt });
    }
  }

  for (const candidate of candidates) {
    const body = await renderThumb(candidate);
    if (body) return webp(body);
  }

  // Все обложки из базы — заглушки (так бывает, когда весь свежий рендер
  // пришёл с другой машины). Тогда в тех же папках ищем самую свежую картинку,
  // которая реально лежит на диске. Это единственное место, где превью само
  // ходит по папке, и только после того, как всё остальное отказало.
  const tried = new Set(candidates.map((c) => path.resolve(c.path)));
  for (const dir of new Set(candidates.map((c) => path.dirname(c.path)))) {
    for (const candidate of await siblingImages(dir, FOLDER_FALLBACK_LIMIT)) {
      if (tried.has(path.resolve(candidate.path))) continue;
      const body = await renderThumb(candidate);
      if (body) return webp(body);
    }
  }

  return new NextResponse('не удалось построить превью', { status: 415 });
}

function webp(body: Buffer) {
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

/**
 * Онлайн-заглушка Dropbox: размер есть, а места на диске файл не занимает.
 *
 * Читать такую нельзя: папка Dropbox работает через Windows Cloud Files, и
 * чтение содержимого не падает с ошибкой, а заставляет клиент скачать файл
 * целиком. Доска на тридцать карточек так просила у Dropbox десятки файлов
 * по 4 МБ разом. Проверено на живой папке: у заглушек (атрибут
 * RECALL_ON_DATA_ACCESS) stat.blocks === 0, у скачанных файлов — больше нуля.
 * Сам stat содержимое не трогает и докачку не запускает.
 */
function isOnlineOnly(st: fs.Stats): boolean {
  return st.size > 0 && st.blocks === 0;
}

/** Картинки в корне папки от свежей к старой — те же правила, что у сканера */
async function siblingImages(dir: string, limit: number): Promise<Candidate[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !isNoiseFile(e.name) && isImage(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }

  const found: Array<Candidate & { size: number }> = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await fs.promises.stat(full);
      // заглушки пропускаем сразу, иначе лимит уйдёт на файлы, которые читать нельзя
      if (isOnlineOnly(st)) continue;
      if (st.size >= CONFIG.minFileSize) found.push({ path: full, at: st.mtime, size: st.size });
    } catch {
      /* исчез между readdir и stat */
    }
  }
  return found
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, limit);
}

/** Превью одного кандидата из кеша или с диска; null — файл не читается */
async function renderThumb(candidate: Candidate): Promise<Buffer | null> {
  // Отдаём только то, что лежит под корнем Dropbox — путь приходит из БД,
  // но проверяем всё равно: дешевле, чем полагаться на инварианты.
  const resolved = path.resolve(candidate.path);
  if (!isInsideRoot(resolved)) return null;

  // Строки, записанные до появления cover_at, добираем stat'ом — один раз,
  // до следующего скана
  let mtimeMs = candidate.at?.getTime() ?? null;
  if (mtimeMs === null) {
    try {
      mtimeMs = fs.statSync(resolved).mtimeMs;
    } catch {
      return null;
    }
  }

  const hash = crypto
    .createHash('sha1')
    .update(`${resolved}:${mtimeMs}:${CONFIG.thumbWidth}`)
    .digest('hex');
  const cached = path.join(CACHE_DIR, `${hash}.webp`);

  try {
    return fs.readFileSync(cached);
  } catch {
    /* в кеше нет — строим */
  }

  // Читаем сами, а не через sharp по пути: на заглушке Dropbox sharp отдаёт
  // невнятное «unsupported image format», а readFile — честную ошибку чтения.
  // Заодно чтение асинхронное: докачка файла не блокирует сервер.
  let body: Buffer;
  try {
    // Заглушку не читаем — см. isOnlineOnly. Превью появится, когда файл
    // окажется на диске: скачает его человек или сам Dropbox.
    if (isOnlineOnly(await fs.promises.stat(resolved))) return null;
    const source = await fs.promises.readFile(resolved);
    body = await sharp(source)
      .resize({ width: CONFIG.thumbWidth, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
  } catch {
    return null;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, body);
  return body;
}
