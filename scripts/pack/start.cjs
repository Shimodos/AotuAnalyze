/**
 * Запуск собранного трекера. Лежит в корне собранной папки рядом с app/ и node/.
 *
 *   node\node.exe start.cjs
 *
 * Задаёт то, что на машине разработчика приходит из .env.local и из папки
 * проекта: где хранить данные, ключ приложения Dropbox, адрес сервера и
 * путь к собранному скану. Уже заданные переменные не перекрывает — так
 * программу можно запустить с другой папкой данных или портом.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const app = path.join(__dirname, 'app');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));

const set = (name, value) => {
  if (!process.env[name]) process.env[name] = value;
};

// В Program Files писать нельзя — база и кеш превью живут в профиле пользователя
const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
set('VIARDE_DATA_DIR', path.join(local, 'ViardeTracker'));
fs.mkdirSync(process.env.VIARDE_DATA_DIR, { recursive: true });

set('DROPBOX_APP_KEY', settings.dropboxAppKey);
set('VIARDE_SCAN_SCRIPT', path.join(app, 'scan.cjs'));

// Только этот компьютер. Порт 3000 — на него настроен адрес возврата
// после входа в приложении Dropbox.
set('HOSTNAME', '127.0.0.1');
set('PORT', '3000');
set('NODE_ENV', 'production');

require(path.join(app, 'server.js'));
