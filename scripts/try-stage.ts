/** Проверка веток модели стадии на синтетических данных */
import { computeStage } from '../src/scanner/stage';
import type { ScannedProject, ScannedScene } from '../src/scanner/scan';

const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day);

function scene(over: Partial<ScannedScene>): ScannedScene {
  return {
    name: 'Scene_1', skus: ['KPF-1610'], sceneNumber: '1', isService: false,
    imageCount: 0, exrCount: 0, lastExrAt: null, psdCount: 0, lastPsdAt: null,
    psdFolder: null, psdStages: [], plannedTotal: 0, plannedMatched: 0, plannedMissing: [], plannedGroups: [],
    phase: 'EMPTY', versions: [],
    lastImageAt: null, coverPath: null, hasUnrecognizedFiles: false, ...over,
  };
}

function project(scenes: ScannedScene[], deliveries: ScannedProject['deliveries'] = []): ScannedProject {
  return {
    key: 'job:999', folderName: 'Kraus_999_Test', path: 'X', jobNumber: 999, title: 'Test',
    hasStandardStructure: true, missingFolders: [], deliveries, scenes,
    clientFeedbackFolders: [], anomalies: [], sizeBytes: null,
  };
}

const delivery = (daysAgo: number) => [{
  folderName: 'Kraus_999_Test_Preview', kind: 'PREVIEW' as const, round: null,
  isJunk: false, fileCount: 10, sentAt: ago(daysAgo), coverPath: null, coverAt: ago(daysAgo),
}];

const cases: Array<[string, ScannedProject]> = [
  ['пост свежее рендера, рендер закончен',
    project([scene({ phase: 'POST', imageCount: 5, lastImageAt: ago(5), exrCount: 5, lastExrAt: ago(6), psdCount: 5, lastPsdAt: ago(1) })])],
  ['пост свежее, но одна сцена ещё рендерится',
    project([
      scene({ name: 'A', phase: 'POST', imageCount: 5, lastImageAt: ago(5), psdCount: 5, lastPsdAt: ago(1) }),
      scene({ name: 'B', phase: 'RENDERING', exrCount: 3, lastExrAt: ago(4) }),
    ])],
  ['рендер свежее поста',
    project([scene({ phase: 'POST', imageCount: 5, lastImageAt: ago(1), psdCount: 5, lastPsdAt: ago(3) })])],
  ['пост свежее, но уже отгружено позже',
    project([scene({ phase: 'POST', imageCount: 5, lastImageAt: ago(5), psdCount: 5, lastPsdAt: ago(3) })], delivery(1))],
  ['только EXR, ничего больше',
    project([scene({ phase: 'RENDERING', exrCount: 8, lastExrAt: ago(1) })])],
  ['пусто везде',
    project([scene({})])],
];

for (const [label, p] of cases) {
  const s = computeStage(p);
  console.log('  ' + label.padEnd(42) + '-> ' + s.column.padEnd(11) + ' мяч: ' + s.ball + '  основание: ' + s.evidence.code);
}
