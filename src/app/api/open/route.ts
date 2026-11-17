import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { errorMessage, jsonError, readJson, requireSameOrigin } from '@/server/http';
import { isInsideRoot } from '@/server/paths';

export const dynamic = 'force-dynamic';

/**
 * Открывает папку в файловом менеджере.
 *
 * Папка открывается на той машине, где крутится сервер. Пока доска открыта
 * с самой этой машины (localhost) — это ровно то, что нужно. Если зашли по
 * сети, окно вылезло бы у чужого человека, поэтому такой запрос отклоняем и
 * возвращаем путь: интерфейс предложит скопировать его.
 *
 * Проверка по заголовку Host отсекает браузер, зашедший по IP, но не
 * консольный клиент из сети, который Host подделает. От CSRF защищает
 * requireSameOrigin, от запуска файлов — проверка isDirectory ниже.
 * Если доска должна быть доступна только с этой машины, надёжнее
 * слушать 127.0.0.1: `next start -H 127.0.0.1`.
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
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const body = await readJson<{ path?: string }>(request);
  if (!body) return jsonError('некорректный запрос', 400);
  if (!body.path) return jsonError('path обязателен', 400);

  // Мы запускаем процесс, поэтому путь проверяем строго: только внутри корня
  // Dropbox. Аргументы передаём массивом, без shell — подстановка команд невозможна.
  const target = path.resolve(body.path);
  if (!isInsideRoot(target)) return jsonError('путь вне корня Dropbox', 403);

  // Только каталог. explorer.exe с путём к файлу ЗАПУСКАЕТ этот файл
  // ассоциированной программой — а Dropbox общий, и положить туда .exe
  // может любой участник.
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(target).isDirectory();
  } catch {
    return jsonError('папка не найдена на диске', 404);
  }
  if (!isDirectory) return jsonError('это не папка', 400);

  if (!isLocalRequest(request)) {
    return jsonError('Доска открыта по сети — путь можно скопировать', 409, 'remote', { path: target });
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
    return jsonError(errorMessage(error), 500);
  }
}
