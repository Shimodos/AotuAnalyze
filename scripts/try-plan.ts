/** Что даёт разбор плана по проектам */
import { scanProject } from '../src/scanner/scan';
import { CONFIG } from '../src/config';
import { listProjectFolders } from '../src/scanner/scan';

for (const name of listProjectFolders(CONFIG.root)) {
  const p = scanProject(CONFIG.root, name);
  const withPlan = p.scenes.filter((s) => s.plannedTotal > 0);
  if (withPlan.length === 0) continue;
  const total = withPlan.reduce((s, x) => s + x.plannedTotal, 0);
  const done = withPlan.reduce((s, x) => s + x.imageCount, 0);
  console.log(
    `${String(p.jobNumber).padEnd(5)}${p.title.slice(0, 26).padEnd(28)}` +
      `сцен с планом ${String(withPlan.length).padStart(2)}   готово ${String(done).padStart(3)} из ${String(total).padStart(3)}` +
      `   ${Math.round((done / total) * 100)}%`,
  );
}
