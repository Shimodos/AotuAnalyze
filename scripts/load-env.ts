/**
 * Подхватить .env.local, когда скрипт запущен руками (`npm run scan`).
 *
 * Сервер Next читает .env.local сам и передаёт переменные дочернему скану,
 * а у CLI их нет — и токен Dropbox тогда не обновить: нужны ключи приложения.
 * Импортировать ПЕРВЫМ: настройки Dropbox читают process.env при загрузке модуля.
 */

import * as fs from 'node:fs';

if (!process.env.DROPBOX_APP_KEY && fs.existsSync('.env.local')) {
  process.loadEnvFile('.env.local');
}
