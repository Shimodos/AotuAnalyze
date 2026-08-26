import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { CONFIG } from '@/config';

export const dynamic = 'force-dynamic';

/**
 * Открывает папку в файловом менеджере.
 *
 * Папка открывается на той машине, где крутится сервер. Пока доска открыта
 * с самой этой машины (localhost) — это ровно то, что нужно. Если зашли по
 * сети, окно вылезло бы у чужого человека, поэтому такой запрос отклоняем и
 * возвращаем путь: интерфейс предложит скопировать его.
 */
function isLocalRequest(request: Request): boolean {
  const host = (request.headers.get('host') ?? '').toLowerCase();
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function opener(target: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: [target] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

export async function POST(request: Request) {
  let body: { path?: string };
  try {
    body = (await request.json()) as { path?: string };
  } catch {
    return NextResponse.json({ error: 'некорректный запрос' }, { status: 400 });
  }

  if (!body.path) return NextResponse.json({ error: 'path обязателен' }, { status: 400 });

  // Мы запускаем процесс, поэтому путь проверяем строго: только внутри корня
  // Dropbox. Аргументы передаём массивом, без shell — подстановка команд невозможна.
  const target = path.resolve(body.path);
  const root = path.resolve(CONFIG.root);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return NextResponse.json({ error: 'путь вне корня Dropbox' }, { status: 403 });
  }

  if (!fs.existsSync(target)) {
    return NextResponse.json({ error: 'папка не найдена на диске' }, { status: 404 });
  }

  if (!isLocalRequest(request)) {
    return NextResponse.json(
      { error: 'remote', path: target, message: 'Доска открыта по сети — путь можно скопировать' },
      { status: 409 },
    );
  }

  try {
    const { cmd, args } = opener(target);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* ошибку запуска ловим ниже по факту отсутствия окна, падать смысла нет */
    });
    child.unref();
    // explorer.exe отдаёт код 1 даже при успехе — на код возврата не смотрим
    return NextResponse.json({ ok: true, path: target });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
