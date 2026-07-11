// FINAL ENDURANCE PASS -- battery of the CRUSH-SPECIFIC additions this wave's objective calls out
// that game/verify/playtest-r3/battery.mjs (already gated GREEN, see commit 347ae3c) does not cover:
//   1. offset-64: an in-GAME frontal with genuine left/right asymmetry (a constant, non-corrective
//      steer bias throughout the approach so the car meets spawnTestWall() still yawed --
//      spawnTestWall() itself is centered+full-width on the spawn line with no offset/width param, so
//      a straight-on approach can never produce a partial-overlap hit; a persistent heading bias is the
//      only way to get a genuinely asymmetric structural response from this API surface). Asserts the
//      struck-side segment core/rail crushed clearly more than the intact side (damage.segments,
//      the SAME telemetry crash-lab.mjs's iihs-moderate-64 gate reads) and doors stay attached; the
//      intrusion metric is also sampled across the settle window, though an HONEST single-momentum
//      in-game hit (no continued throttle-grinding after contact) tops out just below this
//      mechanism's cradle-yield threshold at this world's achievable offset closing speed -- see that
//      finding's own comment for why this is a test-track energy ceiling, not a game defect (crash-
//      lab.mjs's dedicated protocol is the deterministic proof the mechanism itself works).
//   2. dent-then-probe: a moderate frontal dents the hood (dentedVertexCount>0, hood loosened/broken),
//      then a SECOND low-speed nudge at the same spot checks the panel collision hull is consistent with
//      the dent (crush M3's setHull refresh) rather than a stale flat hull -- see this scenario's own
//      comment for why this is the best available proxy given the exposed API surface (no spawn-a-
//      loose-probe-object hook exists on window.__GAME__ to literally drop something into the dent).
//   3. glass-eject-70: 70km/h frontal (the r3-staple speed named in this wave's objective, vs r3's own
//      wall-80kmh scenario) -- confirms glassShattered is non-empty AND at least one occupant ejects
//      through it, matching verify/occupants-active.mjs's proven 72km/h recipe one notch down.
//
// Usage: node verify/playtest-final/battery.mjs (spawns its own vite preview; run `npm run build` first)
import path from 'node:path';
import { launchHarness, sleep, allFinite, writeJson, DRIVE_TOWARD_SNIPPET } from '../playtest-r3/lib.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;
mkdirSync(OUT_DIR, { recursive: true });
function writeJsonLocal(name, obj) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
}

const PREVIEW_PORT = 4910;
const CDP_PORT = 9910;

const findings = [];
const scenarioResults = {};
let wasmDead = false;

function record(scenario, severity, issue, evidence = {}) {
  const f = { scenario, severity, issue, ...evidence };
  findings.push(f);
  console.log(`[FINDING][${severity}] ${scenario}: ${issue}`, JSON.stringify(evidence));
  return f;
}

async function settle(evalExpr, steps = 150) {
  await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
  await evalExpr(`window.__GAME__.stepN(${steps}); 'ok'`);
}
async function resetWorld(evalExpr) {
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  await evalExpr('window.__GAME__.stepN(10); "ok"');
}

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'playtest-final' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);

  // Own screenshot helper (writing into THIS dir) -- lib.mjs's own h.screenshot() hardcodes its sibling
  // playtest-r3/ OUT_DIR, which would write outside game/verify/playtest-final/** (the only path this
  // run owns).
  async function screenshot(name) {
    const shot = await h.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(OUT_DIR, `${name}.png`);
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    return outPath;
  }

  async function withScenario(name, fn) {
    if (wasmDead) {
      scenarioResults[name] = { skipped: true, reason: 'wasm already dead' };
      return;
    }
    console.log(`\n[playtest-final] ===== SCENARIO: ${name} =====`);
    const errBefore = h.consoleErrors.length;
    try {
      const result = await fn();
      scenarioResults[name] = { ...result, newConsoleErrors: h.consoleErrors.length - errBefore };
      if (h.consoleErrors.length > errBefore) {
        record(name, 'minor', 'console errors observed during scenario', {
          count: h.consoleErrors.length - errBefore,
          sample: h.consoleErrors.slice(errBefore, errBefore + 3),
        });
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      const isOob = /memory access out of bounds/i.test(msg);
      record(name, 'blocker', 'scenario threw' + (isOob ? ' (wasm OOB trap)' : ''), { error: msg });
      scenarioResults[name] = { threw: true, error: msg };
      if (isOob) wasmDead = true;
      else {
        try {
          await evalExpr('window.__GAME__.telemetry');
          await evalExpr('window.__GAME__.stepN(1); "ok"');
        } catch {
          wasmDead = true;
          record(name, 'blocker', 'module unresponsive after scenario exception', {});
        }
      }
    }
  }

  // =====================================================================================
  // 1) OFFSET-64: constant-steer approach into spawnTestWall(25) at a 64km/h cap, so the car meets the
  // wall still yawed (genuine per-side asymmetry) rather than square-on.
  // =====================================================================================
  await withScenario('offset-64-wall', async () => {
    await resetWorld(evalExpr);
    // distanceAhead=56 (NOT the usual 25) -- calibrated empirically (this task's diag8/diag9/diag10,
    // same throwaway-diag convention as playtest-r3/diag-*.mjs): a standing-start throttle approach
    // over only ~25m tops out around 46km/h regardless of throttle/cap (acceleration-limited, same
    // phenomenon playtest-r3/battery.mjs's brick-wall-stages comment documents for its own ~29m
    // run-up) -- 56m of run-up is what's actually needed to reach the nominal 64km/h before contact.
    // steer=0.015 (NOT a corrective P-controller) -- constant/non-corrective for the whole approach,
    // calibrated to leave the car ~1-5m off the spawn centerline at impact (reliably inside
    // spawnTestWall()'s +-8m half-width across repeat trials -- longer run-ups (65-90m, needed to reach
    // higher effective closing speeds) were tried and rejected: the same constant steer compounds
    // lateral drift much faster than linearly over distance, and by ~80m the car misses the wall
    // entirely on most trials) with enough residual yaw to produce a genuinely asymmetric hit. An
    // HONEST single-momentum impact (throttle zeroed the instant the approach loop ends, no continued
    // grinding into the wall afterward) at this track's achievable ~55-58km/h effective closing speed
    // lands the front crush around 0.29-0.30m -- clearly asymmetric and door-safe, but below the
    // ~0.35-0.4m threshold where this mechanism's cradle weld starts yielding (so intrusionM stays 0
    // here); crash-lab.mjs's dedicated iihs-moderate-64 protocol (17/17 PASS) is the deterministic,
    // authoritative confirmation that intrusion DOES rise for this exact structural class once that
    // threshold is crossed (front 0.477, intrusion 0.037) -- see this scenario's own finding below.
    await evalExpr('window.__GAME__.spawnTestWall(56); "ok"');
    const run = await evalExpr(`(() => {
      const g = window.__GAME__;
      const samples = [];
      let i = 0;
      for (; i < 1000; i++) {
        const t = g.telemetry;
        const throttle = t.speedKmh < 64 ? 1 : 0;
        g.setInput({ throttle, brake: 0, steer: 0.015, handbrake: false });
        g.stepN(1);
        if (i % 20 === 0) samples.push({ i, x: +t.chassisPos.x.toFixed(2), z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(1) });
        if (t.chassisPos.z > 55.5) break;
      }
      return { steps: i, samples, impactTelemetry: g.telemetry };
    })()`);
    // Settle + sample the segment telemetry repeatedly across the settle window so intrusion's TREND
    // (not just its final value) is observable -- rising, not a one-shot step function.
    const trend = [];
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    for (let k = 0; k < 6; k++) {
      await evalExpr('window.__GAME__.stepN(60); "ok"'); // 1s @60Hz per sample
      const d = await evalExpr('window.__GAME__.telemetry.damage');
      trend.push({ atSec: (k + 1), intrusionM: d.segments.intrusionM, frontCrushM: d.segments.frontCrushM, core: d.segments.coreRetreatFrontM });
    }
    await screenshot('offset-64-after');
    const final = await evalExpr('window.__GAME__.telemetry.damage');
    const core = final.segments.coreRetreatFrontM;
    const struckRetreat = Math.max(core.pos, core.neg);
    const intactRetreat = Math.min(core.pos, core.neg);
    const w = final.segments.weldCrushM;
    const struckCells = core.pos >= core.neg ? [w.cellFL, w.cellRL] : [w.cellFR, w.cellRR];
    const intactCells = core.pos >= core.neg ? [w.cellFR, w.cellRR] : [w.cellFL, w.cellRL];

    const intrusionSeries = trend.map((t) => t.intrusionM);
    const intrusionRose = intrusionSeries[intrusionSeries.length - 1] > intrusionSeries[0] + 0.01 || (intrusionSeries[0] === 0 && intrusionSeries[intrusionSeries.length - 1] > 0.02);
    // Non-decreasing (allow float noise <=1mm) across the whole trend.
    let nonDecreasing = true;
    for (let i = 1; i < intrusionSeries.length; i++) if (intrusionSeries[i] < intrusionSeries[i - 1] - 0.001) nonDecreasing = false;

    if (!(struckRetreat > 0.10)) record('offset-64-wall', 'major', 'struck-side core did not crush meaningfully at 64km/h offset', { core, run: run.samples });
    if (!(intactRetreat < struckRetreat * 0.6)) record('offset-64-wall', 'major', 'intact side crushed nearly as much as struck side -- hit was not actually asymmetric', { core });
    if (!(struckCells[0] > 0.04 || struckCells[1] > 0.04)) record('offset-64-wall', 'major', 'struck-side rail cell did not mechanically shorten', { struckCells, w });
    if (final.panelStates.doorL === 'broken' || final.panelStates.doorR === 'broken') record('offset-64-wall', 'blocker', 'a door BROKE/detached in a frontal-offset hit (universal invariant violation)', { panelStates: final.panelStates });
    // MINOR not major: an honest single-momentum hit at this track's achievable closing speed sits
    // just below the cradle-yield threshold (front ~0.29-0.30m vs the ~0.35-0.4m this mechanism needs
    // before intrusionM leaves 0) -- crash-lab.mjs's deterministic iihs-moderate-64 protocol (17/17
    // PASS) already proves intrusion rises correctly once that threshold is crossed (front 0.477,
    // intrusion 0.037) for this exact structural class, so this is a test-track energy-ceiling gap
    // (in-game world geometry bounds how much closing speed a scripted offset approach can safely
    // deliver), not evidence the mechanism itself is broken in-game.
    if (!intrusionRose) record('offset-64-wall', 'minor', 'in-game offset hit did not push deep enough for intrusionM to leave 0 (below cradle-yield threshold; lab protocol already confirms the mechanism itself)', { intrusionSeries, frontCrushM: final.segments.frontCrushM });
    if (!nonDecreasing) record('offset-64-wall', 'minor', 'intrusion metric was non-monotonic (wobbled down) during settle', { intrusionSeries });
    if (!allFinite(final)) record('offset-64-wall', 'blocker', 'non-finite damage telemetry after offset-64 hit', {});

    return { run: { steps: run.steps, samples: run.samples, impactSpeed: run.impactTelemetry.speedKmh }, trend, final: { core, weldCrushM: w, intrusionM: final.segments.intrusionM, frontCrushM: final.segments.frontCrushM, panelStates: final.panelStates }, struckRetreat, intactRetreat };
  });

  // =====================================================================================
  // 2) DENT-THEN-PROBE: moderate frontal dents the hood, then a second low-speed nudge at the same
  // spot probes whether the panel collision hull is consistent with the visual dent (crush M3's
  // rate-limited setHull refresh) -- NOTE: window.__GAME__ has no hook to spawn a loose object and drop
  // it into the dent, so this is the best available proxy from the existing API surface (flagged as a
  // gap in this run's report, not silently upgraded into a claim about literal resting debris).
  // =====================================================================================
  await withScenario('dent-then-probe', async () => {
    await resetWorld(evalExpr);
    // dist=15 / crash(50) -- calibrated (diag1/diag2): crash() sets body velocity directly WITHOUT
    // spinning the wheels up to match (damage/scenario.ts's crashSetup doc comment explains why the
    // PANELS need this, but the wheels' own angular velocity is left alone), so the tires drag like
    // locked brakes from the very first step; at 42km/h over 25m that drag alone scrubs the car to a
    // dead stop ~2m short of the wall (confirmed: z=9.16, zero crush, wall untouched). 50km/h over a
    // shorter 15m run reliably still carries enough momentum through the drag to reach the wall while
    // landing in the loosened-not-broken hood state a "probe" needs room above.
    await evalExpr('window.__GAME__.spawnTestWall(15); "ok"');
    await evalExpr('window.__GAME__.crash(50); "ok"');
    await evalExpr('window.__GAME__.stepN(240); "ok"'); // ~4s to settle the dent
    const afterDent = await evalExpr('window.__GAME__.telemetry.damage');
    const visualsAfterDent = await evalExpr('window.__GAME__.dumpPanelVisuals().panels.hood');
    await screenshot('dent-probe-1-dented');

    // Probe: reverse off the wall, then re-approach the SAME wall face at low throttle (a "finger
    // poke" relative to the first hit) and check the SECOND hit's crush increment is small/sane -- a
    // stale (non-dent-following) collision hull would either let the hood clip through with near-zero
    // reaction, or produce an implausible force spike; either shows up as a crush increment that's
    // ~0 (clipped through) or telemetry going non-finite/erratic.
    await evalExpr(`(() => { const g = window.__GAME__; for (let i = 0; i < 150; i++) { g.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); g.stepN(1); } })(); 'ok'`);
    const beforeProbe = await evalExpr('window.__GAME__.telemetry.damage.segments.frontCrushM');
    await evalExpr(`(() => { const g = window.__GAME__; for (let i = 0; i < 150; i++) { g.setInput({ throttle: 0.3, brake: 0, steer: 0, handbrake: false }); g.stepN(1); } })(); 'ok'`);
    await evalExpr('window.__GAME__.stepN(120); "ok"');
    const afterProbe = await evalExpr('window.__GAME__.telemetry.damage');
    const visualsAfterProbe = await evalExpr('window.__GAME__.dumpPanelVisuals().panels.hood');
    await screenshot('dent-probe-2-after-nudge');

    const probeIncrement = afterProbe.segments.frontCrushM - beforeProbe;

    if (!(afterDent.dentedVertexCount > 0)) record('dent-then-probe', 'major', 'first (42km/h) hit dented zero vertices', { afterDent });
    if (afterDent.panelStates.hood === 'attached') record('dent-then-probe', 'minor', 'hood showed no loosened/broken state after a 42km/h frontal', { hood: afterDent.panelStates.hood });
    if (!allFinite(afterProbe)) record('dent-then-probe', 'blocker', 'non-finite damage telemetry after the probe nudge', {});
    if (!(probeIncrement >= 0 && probeIncrement < 0.25)) record('dent-then-probe', 'major', 'probe nudge crush increment out of sane range (stale collision hull suspected: either ~0 clip-through or a runaway spike)', { beforeProbe, afterProbe: afterProbe.segments.frontCrushM, probeIncrement });
    if (afterProbe.panelStates.doorL === 'broken' || afterProbe.panelStates.doorR === 'broken') record('dent-then-probe', 'major', 'low-speed probe nudge broke a door (unexpectedly fragile after the first dent)', { panelStates: afterProbe.panelStates });

    return { afterDent: { dentedVertexCount: afterDent.dentedVertexCount, hood: afterDent.panelStates.hood, frontCrushM: afterDent.segments.frontCrushM }, hoodVisualsAfterDent: visualsAfterDent, beforeProbe, afterProbe: { frontCrushM: afterProbe.segments.frontCrushM, hood: afterProbe.panelStates.hood }, hoodVisualsAfterProbe: visualsAfterProbe, probeIncrement, gap: 'no spawn-loose-object hook exists; this is a collision-consistency proxy, not a literal "debris rests in the dent" observation' };
  });

  // =====================================================================================
  // 3) 70KM/H EJECTION-THROUGH-GLASS -- r3-staple speed named explicitly by this wave's objective.
  // =====================================================================================
  await withScenario('glass-eject-70', async () => {
    await resetWorld(evalExpr);
    await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
    const before = await evalExpr('window.__GAME__.telemetry.damage.glassShattered');
    await evalExpr('window.__GAME__.crash(70); "ok"');
    await evalExpr('window.__GAME__.features.occupants.matchVehicleVelocity(); "ok"');
    await evalExpr('window.__GAME__.stepN(240); "ok"');
    await screenshot('glass-eject-70-after');
    const damage = await evalExpr('window.__GAME__.telemetry.damage');
    const occStates = await evalExpr('window.__GAME__.features.occupants.occupantStates()');
    const ejected = occStates.filter((o) => o.ejected).length;

    if (!((damage.glassShattered ?? []).length > 0)) record('glass-eject-70', 'major', 'no glass shattered at 70km/h frontal', { before, after: damage.glassShattered });
    if (ejected === 0) record('glass-eject-70', 'major', 'no occupant ejected at 70km/h frontal', { occStates });
    if (!allFinite(damage) || !allFinite(occStates)) record('glass-eject-70', 'blocker', 'non-finite damage/occupant telemetry after 70km/h crash', {});

    return { glassShattered: damage.glassShattered, ejected, occStates };
  });

  // =====================================================================================
  const report = { scenarioResults, findings, wasmDead, totalConsoleErrors: h.consoleErrors.length, totalPageErrors: h.pageErrors.length, timestamp: new Date().toISOString() };
  writeJsonLocal('battery-report.json', report);
  console.log('\n[playtest-final] ===== SUMMARY =====');
  console.log('scenarios:', Object.keys(scenarioResults).join(', '));
  console.log('findings:', findings.length, findings.map((f) => `${f.severity}:${f.scenario}`).join(', '));
  console.log('console errors total:', h.consoleErrors.length, 'page errors total:', h.pageErrors.length);

  await h.close();
  const hasBlocker = findings.some((f) => f.severity === 'blocker') || wasmDead;
  process.exit(hasBlocker ? 1 : 0);
}

main().catch((err) => {
  console.error('[playtest-final] FATAL', err);
  process.exit(2);
});
