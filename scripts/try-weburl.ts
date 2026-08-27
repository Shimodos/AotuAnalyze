/** Сверка построенных ссылок с реальной ссылкой из браузера */
import { fileWebUrl, folderWebUrl } from '../src/dropbox/webUrl';

// Прямые слэши: Node их понимает на Windows, а path.resolve всё равно нормализует
const folders = [
  'D:/Viarde Studio Dropbox/Kraus_211_Gold_Finish_Refresh/05_Outbox/Kraus_211_Gold_Finish_Refresh_Prefinal/Interior/SFACB',
  'D:/Viarde Studio Dropbox/Kraus_210_Fairlane _Non_Workstation/04_JPG',
  "D:/Viarde Studio Dropbox/Kraus_199_Lowe's Retail Sinks/04_JPG",
  'C:/Windows/System32',
];

for (const folder of folders) {
  console.log('  ' + (folderWebUrl(folder) ?? 'вне корня Dropbox — кнопки не будет'));
}

console.log('\n  файл:');
console.log(
  '  ' +
    fileWebUrl(
      'D:/Viarde Studio Dropbox/Kraus_211_Gold_Finish_Refresh/05_Outbox/' +
        'Kraus_211_Gold_Finish_Refresh_Prefinal/Interior/SFACB/S1_KFF-2631SFACB_KFR1-33WH_Angle01.jpg',
    ),
);
console.log('\n  ссылка из браузера для сравнения:');
console.log(
  '  https://www.dropbox.com/home/Kraus_211_Gold_Finish_Refresh/05_Outbox/' +
    'Kraus_211_Gold_Finish_Refresh_Prefinal/Interior/SFACB?preview=S1_KFF-2631SFACB_KFR1-33WH_Angle01.jpg',
);
