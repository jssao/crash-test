// SPDX-License-Identifier: MIT
//
// Eyes-on verify for the COMPOUND-IN-A-FOREST terrain overhaul (compound-world worker). Launches the
// real headed browser, reports render draw-calls / triangles / body counts, and captures the four
// "does it read as a forest compound?" views the orchestrator asked for:
//   1. spawn-chase    -- the yard as the player first sees it (forest wall ahead, gate/driveway).
//   2. gate-driveway  -- driving north out the gate, up the washboard driveway.
//   3. road-forest    -- out on the loop, trees pressing to the road edges.
//   4. aerial         -- high orbit: the whole fenced compound sitting in the woods.
//   5. yard-orbit     -- medium orbit over the yard: buildings ringing the destructible clutter.
// Same harness pattern as verify/perf-headed.mjs.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function shot(h, name) {
  const s = await h.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(__dirname, `compound-${name}.png`);
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log('[compound] shot', p);
  return p;
}

async function main() {
  let h;
  try {
    h = await launchHarness({ previewPort: 4199, cdpPort: 9449, width: 1280, height: 720, headed: true, label: 'compound-world' });
  } catch (err) {
    const report = { skipped: true, reason: 'no headed browser/display', error: String((err && err.message) || err) };
    console.log('[compound] SKIPPED:', report.reason, '--', report.error);
    writeFileSync(path.join(__dirname, 'console-report-compound-world.json'), JSON.stringify(report, null, 2));
    process.exit(2);
  }
  const { evalExpr } = h;
  const report = { headed: true };
  try {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(600);

    // ---- Render / body-count metrics ----
    report.render = await evalExpr(
      `(() => { const r = window.__GAME__.renderer.info.render; return { drawCalls: r.calls, triangles: r.triangles }; })()`,
    );
    report.bodies = await evalExpr(
      `(() => ({ destructibles: window.__GAME__.destructibleBodyCount, features: window.__GAME__.featureBodyCount(), liveHandles: window.__GAME__.liveHandleCount() }))()`,
    );
    report.trees = await evalExpr('window.__GAME__.features.trees.snapshot ? { saplings: window.__GAME__.features.trees.snapshot().saplings.length, mids: window.__GAME__.features.trees.snapshot().mids.length, larges: window.__GAME__.features.trees.snapshot().larges.length } : null');
    console.log('[compound] render:', JSON.stringify(report.render), 'bodies:', JSON.stringify(report.bodies), 'trees:', JSON.stringify(report.trees));

    // ---- 1) spawn-chase (default chase cam, car at spawn facing the yard/gate) ----
    report.spawnChase = await shot(h, 'spawn-chase');

    // ---- 2) gate-driveway: drive north out the gate up the driveway ----
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(2600);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(350);
    report.gateTelemetry = await evalExpr('({ z: window.__GAME__.telemetry.chassisPos.z })');
    report.gateDriveway = await shot(h, 'gate-driveway');

    // ---- 3) road-forest: keep driving up onto the loop, trees pressing the edges ----
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(3200);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(350);
    report.roadTelemetry = await evalExpr('({ z: window.__GAME__.telemetry.chassisPos.z, x: window.__GAME__.telemetry.chassisPos.x })');
    report.roadForest = await shot(h, 'road-forest');

    // ---- 4) aerial: high orbit over the compound (reset the car back into the yard first) ----
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await sleep(400);
    // Kept inside the fog's clear range (fog far ~250m) so the compound + enclosing treeline read,
    // rather than dissolving into the mist a far/high orbit would show.
    await evalExpr('window.__GAME__.setOrbitView({ radius: 88, height: 60, targetHeight: 0 }); window.__GAME__.setFixedAngle(0.7); "ok"');
    await sleep(700);
    report.aerial = await shot(h, 'aerial');

    // ---- 5) yard-orbit: medium orbit over the yard ----
    await evalExpr('window.__GAME__.setOrbitView({ radius: 52, height: 26, targetHeight: 2 }); window.__GAME__.setFixedAngle(2.35); "ok"');
    await sleep(700);
    report.yardOrbit = await shot(h, 'yard-orbit');

    report.consoleErrors = h.consoleErrors;
    report.pageErrors = h.pageErrors;
    report.timestamp = new Date().toISOString();
    console.log('[compound] console errors:', h.consoleErrors.length, 'page errors:', h.pageErrors.length);
    console.log('[compound] gate z=', report.gateTelemetry?.z?.toFixed?.(1), 'road z=', report.roadTelemetry?.z?.toFixed?.(1));
    writeFileSync(path.join(__dirname, 'console-report-compound-world.json'), JSON.stringify(report, null, 2));

    const ok = h.consoleErrors.length === 0 && h.pageErrors.length === 0;
    await h.close();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('[compound] FATAL', err);
    report.error = String((err && err.message) || err);
    writeFileSync(path.join(__dirname, 'console-report-compound-world.json'), JSON.stringify(report, null, 2));
    await h.close();
    process.exit(1);
  }
}

main();
