// SPDX-License-Identifier: MIT
//
// ONE-OFF AUDIT (not a regression gate -- no CI hook, run by hand): high-quality eyes-on screenshots
// of the Mustang-65 from every angle + through glass + hood-off, so the orchestrator's directive
// ("cull procedural cardetail duplicates the model already provides") can be judged from real
// screenshots, not a file listing. Reuses the enginebay-visual.mjs `?quality=high` reload pattern.
//
// Usage: node verify/audit-cardetail.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'audit-cardetail');
import { mkdirSync } from 'node:fs';
mkdirSync(OUT_DIR, { recursive: true });

async function reloadWithHighQuality(evalExpr) {
	await evalExpr("location.href = location.href.split('?')[0] + '?quality=high'; 'ok'");
	let ok = false;
	for (let i = 0; i < 60; i++) {
		const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true').catch(() => false);
		if (r === true) {
			ok = true;
			break;
		}
		await sleep(500);
	}
	if (!ok) throw new Error('reload with ?quality=high never became ready');
	await sleep(1500);
}

async function main() {
	const h = await launchHarness({ previewPort: 4260, cdpPort: 9560, width: 1600, height: 900, headed: false, label: 'audit-cardetail' });
	const { evalExpr, send } = h;
	let exitCode = 0;
	const report = {};

	async function screenshot(name) {
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
		console.log(`[audit-cardetail] wrote ${name}.png`);
	}

	try {
		await reloadWithHighQuality(evalExpr);
		console.log('[audit-cardetail] forced quality:', await evalExpr('window.__GAME__.quality'));

		// Hide the on-screen HUD/help card so it doesn't obscure the car in these audit shots.
		await evalExpr(`
      document.querySelectorAll('div').forEach((d) => {
        if (d.textContent && d.textContent.includes('box3d crash sandbox')) d.style.display = 'none';
      });
      'ok';
    `);

		// ---- Spawn-state, all angles, intact car ----
		const spawnShots = [
			{ name: 'spawn-front', radius: 6, height: 1.6, targetHeight: 0.55, angle: Math.PI / 2 },
			{ name: 'spawn-3q-front', radius: 6, height: 1.8, targetHeight: 0.55, angle: Math.PI / 3 },
			{ name: 'spawn-side', radius: 6, height: 1.6, targetHeight: 0.55, angle: 0 },
			{ name: 'spawn-3q-rear', radius: 6, height: 1.8, targetHeight: 0.55, angle: (-2 * Math.PI) / 3 },
			{ name: 'spawn-rear', radius: 6, height: 1.6, targetHeight: 0.55, angle: -Math.PI / 2 },
			{ name: 'spawn-top', radius: 6, height: 9, targetHeight: 0.3, angle: Math.PI / 4 },
			{ name: 'spawn-close-front', radius: 3, height: 1.1, targetHeight: 0.5, angle: Math.PI / 2 },
		];
		for (const s of spawnShots) {
			await evalExpr(`window.__GAME__.setOrbitView({ radius: ${s.radius}, height: ${s.height}, targetHeight: ${s.targetHeight} }); "ok"`);
			await evalExpr(`window.__GAME__.setFixedAngle(${s.angle}); 'ok'`);
			await sleep(700);
			await screenshot(s.name);
		}

		// ---- Through glass, close, looking into the cabin (dash/wheel/seats) ----
		await evalExpr('window.__GAME__.setOrbitView({ radius: 2.4, height: 1.5, targetHeight: 0.55 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI}); 'ok'`);
		await sleep(800);
		await screenshot('interior-through-windshield');

		await evalExpr('window.__GAME__.setOrbitView({ radius: 2.2, height: 1.3, targetHeight: 0.5 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI * 0.15}); 'ok'`);
		await sleep(800);
		await screenshot('interior-through-side-glass');

		// ---- Hood-off engine bay reveal (60 km/h -- reliably breaks the hood, leaves most cardetail
		// parts still attached so the bay reads full). ----
		report.crash60 = await evalExpr(`
      window.__GAME__.spawnTestWall(8);
      window.__GAME__.crash(60);
      window.__GAME__.stepN(300);
      ({
        detachedCount: window.__GAME__.features.cardetail.detachedCount(),
        hoodState: window.__GAME__.telemetry.damage.panelStates.hood,
        states: window.__GAME__.features.cardetail.states(),
      });
    `);
		console.log('[audit-cardetail] crash(60):', JSON.stringify(report.crash60));
		await evalExpr('window.__GAME__.setOrbitView({ radius: 4, height: 3.2, targetHeight: 0.3 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 3}); 'ok'`);
		await sleep(800);
		await screenshot('hoodoff-enginebay-3q');

		await evalExpr('window.__GAME__.setOrbitView({ radius: 3.2, height: 3.5, targetHeight: 0.2 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 2}); 'ok'`);
		await sleep(800);
		await screenshot('hoodoff-enginebay-top-down');

		// ---- Post-crash scatter, harder hit ----
		report.crash150 = await evalExpr(`
      window.__GAME__.spawnTestWall(8);
      window.__GAME__.crash(150);
      window.__GAME__.stepN(300);
      ({ detachedCount: window.__GAME__.features.cardetail.detachedCount(), states: window.__GAME__.features.cardetail.states() });
    `);
		console.log('[audit-cardetail] crash(150):', JSON.stringify(report.crash150));
		await evalExpr('window.__GAME__.setOrbitView({ radius: 6.5, height: 3.2, targetHeight: 0.5 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${(2 * Math.PI) / 3}); 'ok'`);
		await sleep(800);
		await screenshot('crash150-scatter');

		report.consoleErrors = h.consoleErrors;
		report.pageErrors = h.pageErrors;
		if (h.consoleErrors.length > 0 || h.pageErrors.length > 0) exitCode = 1;
	} catch (err) {
		console.error('[audit-cardetail] ERROR', err);
		report.error = String((err && err.message) || err);
		exitCode = 1;
	} finally {
		await h.close();
	}

	writeFileSync(path.join(OUT_DIR, 'console-report.json'), JSON.stringify(report, null, 2));
	console.log('[audit-cardetail] wrote console-report.json');
	process.exit(exitCode);
}

main();
