// SPDX-License-Identifier: MIT
//
// Eyes-on visual QA for the cardetail SHAPED-MESH pass (game/src/world/features/cardetail/shapes.ts):
// captures the 3 screenshots this task's brief calls for -- hood-off engine-bay close-up (setOrbitView
// radius ~4), interior through the windshield, and a post-crash scatter with shaped parts visible on
// the ground -- so the modeling agent (and the user) can actually LOOK at the ribbed valve cover,
// spiral-volute turbo, finned radiator/intercooler cores, curved hoses, torus+spokes steering wheel,
// seat base+backrest+bolsters, etc. instead of judging from a file listing.
//
// DISTINCT FROM verify/feature-cardetail.mjs: that script is the numeric/console-error REGRESSION gate
// (>=5 detached, hood open, 0 console errors) and intentionally runs at whatever quality the headless
// SwiftShader benchmark auto-picks (usually 'low', since a software rasterizer profiles as low-end).
// This script forces `?quality=high` (reload-after-ready, since window.__GAME__ has no public
// setQuality() -- only a read-only `.quality` getter, see src/main.ts) so the screenshots reflect what
// a real player on a real GPU sees, matching the terrain-dirt-south.png quality bar this task is
// judged against.
//
// SPEED CHOICE: 60 km/h reliably breaks the hood (damage-tuning.ts: hood crosses its S2 break stress
// threshold well below 100 km/h) while usually leaving MOST cardetail parts still attached (their
// break thresholds are calibrated against a much harder crash, see tuning.ts's "TUNING DELTA" comment)
// -- exactly what an "engine bay reveal" shot wants: hood open, bay still full of parts to look at. A
// harder second crash (150 km/h) is used for the dedicated scatter shot instead, where a good handful
// of DETACHED, ON-THE-GROUND shaped parts is the whole point.
//
// Usage: node verify/enginebay-visual.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname); // game/verify/ directly -- matches screenshot-cardetail-*.png's
// existing convention, NOT playtest/lib.mjs's own screenshot() helper (which always writes under
// verify/playtest/ -- this script writes screenshots itself instead of using that helper).

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
	await sleep(1500); // shadow map / PMREM / texture settle, matching launchHarness's own post-ready wait
}

async function main() {
	const h = await launchHarness({ previewPort: 4199, cdpPort: 9449, headed: false, label: 'enginebay-visual' });
	const { evalExpr, send } = h;
	let exitCode = 0;
	const report = {};

	async function screenshot(name) {
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
		console.log(`[enginebay-visual] wrote ${name}.png`);
	}

	try {
		await reloadWithHighQuality(evalExpr);
		const qualityLevel = await evalExpr('window.__GAME__.quality');
		console.log('[enginebay-visual] forced quality:', qualityLevel);

		// ---- Shot 1: hood-off engine-bay close-up. 60 km/h into an 8m wall -- breaks the hood, usually
		// leaves most/all cardetail parts attached (see this file's top doc comment). ----
		report.crash60 = await evalExpr(`
      window.__GAME__.spawnTestWall(8);
      window.__GAME__.crash(60);
      window.__GAME__.stepN(300);
      ({
        detachedCount: window.__GAME__.features.cardetail.detachedCount(),
        hoodState: window.__GAME__.telemetry.damage.panelStates.hood,
      });
    `);
		console.log('[enginebay-visual] crash(60):', JSON.stringify(report.crash60));
		await evalExpr('window.__GAME__.setOrbitView({ radius: 4, height: 3.2, targetHeight: 0.3 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 3}); 'ok'`);
		await sleep(800);
		await screenshot('enginebay-visual-hoodoff');

		// ---- Shot 2: interior through the windshield (dashboard/wheel/seats), a closer/lower angle
		// from roughly the cabin's own eye height, looking forward-and-down through the glass. ----
		await evalExpr('window.__GAME__.setOrbitView({ radius: 2.6, height: 1.5, targetHeight: 0.55 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI}); 'ok'`);
		await sleep(700);
		await screenshot('enginebay-visual-interior');

		// ---- Shot 3: post-crash scatter, shaped parts visible on the ground. Harder crash (150 km/h)
		// so a good handful of parts are detached and resting/tumbling nearby. ----
		report.crash150 = await evalExpr(`
      window.__GAME__.spawnTestWall(8);
      window.__GAME__.crash(150);
      window.__GAME__.stepN(300);
      ({ detachedCount: window.__GAME__.features.cardetail.detachedCount() });
    `);
		console.log('[enginebay-visual] crash(150):', JSON.stringify(report.crash150));
		await evalExpr('window.__GAME__.setOrbitView({ radius: 6.5, height: 3.2, targetHeight: 0.5 }); "ok"');
		await evalExpr(`window.__GAME__.setFixedAngle(${(2 * Math.PI) / 3}); 'ok'`);
		await sleep(800);
		await screenshot('enginebay-visual-scatter');

		report.consoleErrors = h.consoleErrors;
		report.pageErrors = h.pageErrors;
		report.qualityLevel = qualityLevel;
		report.timestamp = new Date().toISOString();
		console.log('[enginebay-visual] console errors:', h.consoleErrors.length, 'page errors:', h.pageErrors.length);
		if (h.consoleErrors.length > 0 || h.pageErrors.length > 0) exitCode = 1;
	} catch (err) {
		console.error('[enginebay-visual] ERROR', err);
		report.error = String((err && err.message) || err);
		exitCode = 1;
	} finally {
		await h.close();
	}

	writeFileSync(path.join(OUT_DIR, 'console-report-enginebay-visual.json'), JSON.stringify(report, null, 2));
	console.log('[enginebay-visual] wrote console-report-enginebay-visual.json');
	process.exit(exitCode);
}

main();
