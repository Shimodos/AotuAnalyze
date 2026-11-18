/**
 * Локальная папка Dropbox на этой машине.
 *
 * У каждого компьютера она своя, поэтому путь — настройка, а не константа:
 * хранится в базе и меняется на экране настроек. Читается при каждом
 * обращении: сервер и процесс скана — разные процессы с одной базой, и оба
 * должны увидеть новый путь без перезапуска.
 *
 * Порядок: переменная окружения VIARDE_ROOT (явная подмена — тесты, отладка),
 * затем настройка из базы, затем значение по умолчанию из config.ts.
 */

import { CONFIG } from '@/config';
import { readSetting, writeSetting } from '@/dropbox/tokens';

const KEY = 'app.root';

export type RootSource = 'env' | 'setting' | 'default';

export function rootSource(): RootSource {
  if (process.env.VIARDE_ROOT) return 'env';
  return readSetting(KEY) ? 'setting' : 'default';
}

export function rootDir(): string {
  if (process.env.VIARDE_ROOT) return CONFIG.root;
  return readSetting(KEY) ?? CONFIG.root;
}

export function saveRoot(dir: string) {
  writeSetting(KEY, dir);
}
