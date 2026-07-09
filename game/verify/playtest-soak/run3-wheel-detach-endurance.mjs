// ENDURANCE SOAK run 3: WHEEL-DETACH ENDURANCE -- crash hard enough to detach >=1 wheel, drive on
// rims for 60 REAL seconds (relying on the game's own live requestAnimationFrame loop / fixed-step
// accumulator, same as a real player session -- NOT window.__GAME__.stepN() batching), resetWorld(),
// repeat x5. The RUN 1 (battery.mjs) wasm OOB trap lived in exactly this despawned-body-read pattern
// (a wheel joint destroyed mid-drive, then read again before the visual sync skip-check landed) --
// this confirms it stays clean under repeated cycling.
//
// Crash-until-detached uses the same bounded-retry pattern as verify/playtest/battery.mjs's
// 'wreck-it' scenario (spawnTestWall + crash(), retry up to 6x) -- reused technique, not a copied
// file. Reuses verify/playtest/lib.mjs's harness (read-only import).
//
// Usage: node verify/playtest-soak/run3-wheel-detach-endurance.mjs
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchHarness, sleep, allFinite, gameRoot } from '../playtest/lib.mjs';

const OUT_DIR = path.join(gameRoot, 'verify', 'playtest-soak');
mkdirSync(OUT_DIR, { recursive: true });
function writeJson(name, obj) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
}

const CYCLES = 5;
const DRIVE_ON_RIMS_MS = 60_000;
const CRASH_KMH = 150;
const MAX_ATTEMPTS = 6;

async function main() {
  const h = await launchHarness({ previewPort: 4740, cdpPort: 9740, label: 'soak-run3' });
  const evalExpr = h.evalExpr;
  const cycles = [];
  let wasmDead = false;

  async function fpsText() {
    return evalExpr("document.getElementById('hud-perf') ? document.getElementById('hud-perf').textContent : null");
  }

  for (let cycle = 0; cycle < CYCLES && !wasmDead; cycle++) {
    console.log(`\n[run3] === cycle ${cycle} ===`);
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr('window.__GAME__.stepN(5); "ok"');

    let detachedCount = 0;
    let attempt = 0;
    let attemptLog = [];
    try {
      for (; attempt < MAX_ATTEMPTS && detachedCount < 1; attempt++) {
        await evalExpr(`window.__GAME__.spawnTestWall(20); window.__GAME__.crash(${CRASH_KMH}); 'ok'`);
        await evalExpr('window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); "ok"');
        await evalExpr('window.__GAME__.stepN(240); "ok"'); // ~4s: impact + settle
        const damage = (await evalExpr('window.__GAME__.telemetry')).damage;
        detachedCount = Object.values(damage.wheelStates).filter((s) => s === 'detached').length;
        attemptLog.push({ attempt, detachedCount, wheelStates: damage.wheelStates });
        console.log(`[run3] cycle ${cycle} attempt ${attempt}: detachedCount=${detachedCount}`, damage.wheelStates);
      }
    } catch (err) {
      wasmDead = true;
      cycles.push({ cycle, wasmTrap: true, error: String(err && err.message ? err.message : err), attemptLog });
      break;
    }

    if (detachedCount < 1) {
      cycles.push({ cycle, achievedDetach: false, attemptLog, note: 'never detached a wheel within MAX_ATTEMPTS' });
      console.log(`[run3] cycle ${cycle}: WARNING never detached a wheel within ${MAX_ATTEMPTS} attempts`);
      continue;
    }

    // Drive on rims for 60 REAL seconds via the live rAF loop (not stepN batching) -- setInput persists,
    // sample telemetry/handle counts/console-error counts every ~10s of real wall-clock time.
    const rimSamples = [];
    const t0 = Date.now();
    const errBefore = h.consoleErrors.length;
    let pingErr = null;
    try {
      await evalExpr('window.__GAME__.setInput({ throttle: 0.5, brake: 0, steer: 0.15, handbrake: false }); "ok"');
      while (Date.now() - t0 < DRIVE_ON_RIMS_MS) {
        await sleep(10_000);
        const t = await evalExpr('window.__GAME__.telemetry');
        const lh = await evalExpr('window.__GAME__.liveHandleCount()');
        const fb = await evalExpr('window.__GAME__.featureBodyCount()');
        const fps = await fpsText();
        rimSamples.push({
          elapsedMs: Date.now() - t0,
          speedKmh: t.speedKmh,
          chassisPos: t.chassisPos,
          finite: allFinite(t),
          wheelStates: t.damage.wheelStates,
          liveHandles: lh,
          featureBodies: fb,
          fps,
        });
        console.log(
          `[run3] cycle ${cycle} rim-drive t=${Math.round((Date.now() - t0) / 1000)}s speed=${t.speedKmh.toFixed(1)} liveHandles=${lh} featureBodies=${fb} ${fps}`,
        );
      }
    } catch (err) {
      pingErr = String(err && err.message ? err.message : err);
      wasmDead = true;
    }
    const errAfter = h.consoleErrors.length;

    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); "ok"').catch(() => {});

    cycles.push({
      cycle,
      achievedDetach: true,
      attempts: attempt + 1,
      attemptLog,
      rimDriveMs: Date.now() - t0,
      rimSamples,
      newConsoleErrorsDuringRimDrive: errAfter - errBefore,
      wasmTrapDuringRimDrive: pingErr,
    });
  }

  const findings = [];
  for (const c of cycles) {
    if (c.wasmTrap) findings.push({ cycle: c.cycle, severity: 'blocker', issue: 'wasm OOB trap during crash-until-detach', error: c.error });
    if (c.achievedDetach === false) findings.push({ cycle: c.cycle, severity: 'minor', issue: 'never detached a wheel within MAX_ATTEMPTS' });
    if (c.rimSamples) {
      const badFinite = c.rimSamples.some((s) => !s.finite);
      if (badFinite) findings.push({ cycle: c.cycle, severity: 'blocker', issue: 'NaN/non-finite telemetry during rim-drive' });
    }
    if (c.wasmTrapDuringRimDrive) findings.push({ cycle: c.cycle, severity: 'blocker', issue: 'wasm trap during 60s rim-drive', error: c.wasmTrapDuringRimDrive });
  }

  const summary = {
    cyclesRequested: CYCLES,
    cyclesRun: cycles.length,
    wasmDead,
    totalConsoleErrors: h.consoleErrors.length,
    totalPageErrors: h.pageErrors.length,
    findings,
    perCycle: cycles.map((c) => ({
      cycle: c.cycle,
      achievedDetach: c.achievedDetach,
      attempts: c.attempts,
      liveHandlesFirst: c.rimSamples?.[0]?.liveHandles ?? null,
      liveHandlesLast: c.rimSamples?.[c.rimSamples.length - 1]?.liveHandles ?? null,
      speedFirst: c.rimSamples?.[0]?.speedKmh ?? null,
      speedLast: c.rimSamples?.[c.rimSamples.length - 1]?.speedKmh ?? null,
    })),
  };
  writeJson('run3-wheel-detach-endurance-cycles.json', cycles);
  writeJson('run3-wheel-detach-endurance-summary.json', summary);
  console.log('[run3] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[run3] FATAL', err);
  process.exit(2);
});
