import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { CONFIG } from '@/config';
import { getDb, schema } from '@/db';

export const dynamic = 'force-dynamic';

const CACHE_DIR = path.join(process.cwd(), CONFIG.thumbCacheDir);

/**
 * Превью карточки. Оригиналы весят по 4 МБ — отдавать их в сетку нельзя.
 * Ужимаем в webp и кешируем на диск по ключу «путь + mtime», чтобы
 * пересчитывать только при реальной замене рендера.
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return new NextResponse('key обязателен', { status: 400 });

  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.key, key)).get();
  const source = project?.coverPath;
  if (!source) return new NextResponse('нет обложки', { status: 404 });

  // Отдаём только то, что лежит под корнем Dropbox — путь приходит из БД,
  // но проверяем всё равно: дешевле, чем полагаться на инварианты.
  const resolved = path.resolve(source);
  const root = path.resolve(CONFIG.root);
  if (!resolved.startsWith(root + path.sep)) {
    return new NextResponse('путь вне корня', { status: 403 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return new NextResponse('файл недоступен', { status: 404 });
  }

  const hash = crypto
    .createHash('sha1')
    .update(`${resolved}:${stat.mtimeMs}:${CONFIG.thumbWidth}`)
    .digest('hex');
  const cached = path.join(CACHE_DIR, `${hash}.webp`);

  let body: Buffer;
  if (fs.existsSync(cached)) {
    body = fs.readFileSync(cached);
  } else {
    try {
      body = await sharp(resolved)
        .resize({ width: CONFIG.thumbWidth, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
    } catch {
      return new NextResponse('не удалось построить превью', { status: 415 });
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, body);
  }

  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
