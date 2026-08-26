/** Проверка сопоставления имён PSD-папок со сценами */
import { normalizeShortName, sceneSuffix } from '../src/scanner/parse';

const scenes = [
  'KPF-1616BB_KPF-1691BB_KGTF1-33BL_Scene_2',
  'KPF-2820BB_KPF-2820BBMB_KSF-2830BB_KFR1-33GWH_Scene04',
  'KGTW12-28MGR_KGTW12-28WH_KGTW12-25MBL_Scene_B',
  'KGTW12-28MBL_KGUW2-30MGR_KPF-1693BB_MB_Scene_C',
  'Studio',
];
const psd = ['02', '04', 'B', 'С', 'Studio', 'Lifestyle'];

console.log('хвосты сцен:');
for (const s of scenes) console.log('  ' + s.slice(0, 46).padEnd(48) + '-> ' + (sceneSuffix(s) ?? '—'));
console.log('\nкороткие имена PSD:');
for (const f of psd) console.log('  ' + f.padEnd(12) + '-> ' + normalizeShortName(f));
