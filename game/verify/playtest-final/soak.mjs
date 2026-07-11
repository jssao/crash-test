// FINAL ENDURANCE PASS -- SOAK: 50 crash-reset cycles, seeded mix INCLUDING crush-heavy frontals (full
// NHTSA/IIHS band 56-80km/h straight walls) and offsets (constant-steer angled hits, see
// playtest-final/battery.mjs's offset-64-wall for why a steer bias is how this API surface produces a
// genuinely asymmetric hit), plus the r3 staples (brick/tree/kicker/shed/barrels), each followed by
// resetWorld() and a pristine assert. Specifically watches liveHandleCount for the crush-segment weld
// destroy/recreate churn this wave's objective flags as the new leak candidate (segments.ts creates/
// destroys weld constraints every yield step -- if any of those aren't released on resetWorld(), this
// is where it would show up as a monotonic climb).
//
// Usage: node verify/playtest-final/soak.mjs
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep, allFinite, DRIVE_TOWARD_SNIPPET } from '../playtest-r3/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;
mkdirSync(OUT_DIR, { recursive: true });
function writeJson(name, obj) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
}

const PREVIEW_PORT = 4920;
const CDP_PORT = 9920;
const CYCLES = 50;
const SEED = 0xfeedbead;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
// crush-frontal (straight wall, NHTSA/IIHS band) and crush-offset (angled) are each given 2x weight
// vs the r3 staples -- this soak's whole point is exercising the NEW segment-weld churn path.
const SCENARIOS = ['crush-frontal', 'crush-frontal', 'crush-offset', 'crush-offset', 'brick', 'tree', 'kicker', 'shed', 'barrels'];

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'playtest-final-soak' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);

  async function settle(steps = 180) {
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await evalExpr(`window.__GAME__.stepN(${steps}); "ok"`);
  }

  async function runScenarioOnce(kind) {
    if (kind === 'crush-frontal') {
      const kmh = Math.round(56 + rng() * 24); // 56..80, the NHTSA/IIHS reference band
      await evalExpr(`window.__GAME__.spawnTestWall(25); window.__GAME__.crash(${kmh}); 'ok'`);
      await evalExpr('window.__GAME__.stepN(240); "ok"');
      return { kind, kmh };
    }
    if (kind === 'crush-offset') {
      const kmh = 56 + Math.round(rng() * 16); // 56..72
      const steerSign = rng() < 0.5 ? -1 : 1;
      await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
      const r = await evalExpr(`(() => {
        const g = window.__GAME__;
        let i = 0;
        for (; i < 500; i++) {
          const t = g.telemetry;
          const throttle = t.speedKmh < ${kmh} ? 0.85 : 0;
          g.setInput({ throttle, brake: 0, steer: ${(0.16 * steerSign).toFixed(2)}, handbrake: false });
          g.stepN(1);
          if (t.chassisPos.z > 24.5) break;
        }
        return { steps: i };
      })()`);
      await evalExpr('window.__GAME__.stepN(240); "ok"');
      return { kind, kmh, steerSign, steps: r.steps };
    }
    if (kind === 'brick') {
      const r = await evalExpr('window.__driveToward(16, 24, 500, 1.2, 0.8, 0.7, 90, 20)');
      return { kind, steps: r.steps };
    }
    if (kind === 'tree') {
      const r = await evalExpr('window.__driveToward(-92, -8, 700, 3, 0.7, 0.7, 60, 20)');
      return { kind, steps: r.steps };
    }
    if (kind === 'shed') {
      await evalExpr('window.__driveToward(-26, 27, 420, 4, 0.55, 1.0, 60, 20)');
      const r = await evalExpr('window.__driveToward(-30, 33, 300, 1.2, 0.9, 1.2, 60, 20)');
      return { kind, steps: r.steps };
    }
    if (kind === 'barrels') {
      const r = await evalExpr('window.__driveToward(16, 33, 700, 1.5, 0.85, 0.7, 100, 20)');
      return { kind, steps: r.steps };
    }
    // kicker
    const r = await evalExpr('window.__driveToward(0, 55, 400, 3, 0.9, 1.0, 100, 20)');
    await evalExpr('window.__GAME__.stepN(60); "ok"');
    return { kind, steps: r.steps };
  }

  const rows = [];
  const findings = [];
  let baselineFeatureBodyCount = null;
  let wasmDead = false;

  for (let cycle = 0; cycle < CYCLES && !wasmDead; cycle++) {
    const kind = SCENARIOS[Math.floor(rng() * SCENARIOS.length)];
    const errBefore = h.consoleErrors.length;
    let scenarioResult;
    let trapped = false;
    let trapMsg = null;
    try {
      scenarioResult = await runScenarioOnce(kind);
      await settle();
    } catch (err) {
      trapped = true;
      trapMsg = String(err && err.message ? err.message : err);
    }

    if (trapped) {
      const isKnownOob = /memory access out of bounds/i.test(trapMsg || '');
      findings.push({ cycle, kind, severity: 'blocker', kind_: 'wasm-trap', isKnownOob, trapMsg });
      wasmDead = true;
      rows.push({ cycle, kind, trapped: true, trapMsg });
      break;
    }

    let resetOk = true;
    let resetErr = null;
    try {
      await evalExpr("window.__GAME__.resetWorld(); 'ok'");
      await evalExpr('window.__GAME__.stepN(5); "ok"');
    } catch (err) {
      resetOk = false;
      resetErr = String(err && err.message ? err.message : err);
      wasmDead = true;
    }

    let liveHandles = null, featureBodies = null, seatStates = null, wheelStates = null, displacements = null, segments = null;
    if (resetOk) {
      liveHandles = await evalExpr('window.__GAME__.liveHandleCount()');
      featureBodies = await evalExpr('window.__GAME__.featureBodyCount()');
      seatStates = await evalExpr('window.__GAME__.features.occupants.seatStates()');
      const damage = (await evalExpr('window.__GAME__.telemetry')).damage;
      wheelStates = damage.wheelStates;
      segments = damage.segments;
      displacements = await evalExpr('window.__GAME__.destructibleDisplacements()');
    }

    const errAfter = h.consoleErrors.length;
    const newErrors = errAfter - errBefore;
    const ejectedCount = seatStates ? seatStates.filter((s) => s.ejected).length : null;
    const detachedCount = wheelStates ? Object.values(wheelStates).filter((s) => s === 'detached').length : null;
    const maxDisp = displacements && displacements.length ? Math.max(...displacements) : null;

    if (baselineFeatureBodyCount === null && featureBodies !== null) baselineFeatureBodyCount = featureBodies;

    const row = {
      cycle, kind, scenarioResult, resetOk, resetErr, liveHandles, featureBodies, ejectedCount, detachedCount, maxDisp,
      segmentsAfterReset: segments, newConsoleErrors: newErrors, telemetryFinite: allFinite(seatStates) && allFinite(wheelStates) && allFinite(segments),
    };
    rows.push(row);

    if (!resetOk) findings.push({ cycle, kind, severity: 'blocker', issue: 'resetWorld/stepN threw', resetErr });
    if (featureBodies !== null && baselineFeatureBodyCount !== null && featureBodies !== baselineFeatureBodyCount)
      findings.push({ cycle, kind, severity: 'major', issue: 'featureBodyCount drifted from baseline', baseline: baselineFeatureBodyCount, got: featureBodies });
    if (ejectedCount !== null && ejectedCount !== 0) findings.push({ cycle, kind, severity: 'major', issue: 'occupants not fully re-seated after reset', ejectedCount, seatStates });
    if (detachedCount !== null && detachedCount !== 0) findings.push({ cycle, kind, severity: 'major', issue: 'wheel(s) detached after reset', detachedCount, wheelStates });
    if (maxDisp !== null && maxDisp >= 0.05) findings.push({ cycle, kind, severity: 'major', issue: 'destructible displacement >=0.05m after reset', maxDisp });
    // Crush-specific pristine assert: segments must be back to a rigid, un-crushed state after reset.
    if (segments) {
      const maxWeldCrush = Math.max(...Object.values(segments.weldCrushM || {}));
      if (segments.frontCrushM >= 0.02 || segments.rearCrushM >= 0.02 || maxWeldCrush >= 0.02 || segments.intrusionM >= 0.02) {
        findings.push({ cycle, kind, severity: 'major', issue: 'crush segments not fully re-rigid after resetWorld()', segments });
      }
    }
    if (!allFinite(segments)) findings.push({ cycle, kind, severity: 'blocker', issue: 'non-finite segment telemetry after reset', segments });
    if (newErrors > 0) findings.push({ cycle, kind, severity: 'minor', issue: 'console errors during cycle', newErrors });

    console.log(`[soak] cycle ${cycle} kind=${kind} liveHandles=${liveHandles} featureBodies=${featureBodies} ejected=${ejectedCount} detached=${detachedCount} maxDisp=${maxDisp?.toFixed?.(4)} frontCrush=${segments?.frontCrushM?.toFixed?.(4)} newErrors=${newErrors}`);
  }

  // Monotonic-growth check on liveHandleCount -- the segment weld churn leak candidate.
  const handleSeries = rows.filter((r) => r.liveHandles !== null && r.liveHandles !== undefined).map((r) => r.liveHandles);
  let monotonicGrowth = false;
  let netGrowth = null;
  if (handleSeries.length >= 5) {
    let nonDecreasing = true;
    for (let i = 1; i < handleSeries.length; i++) if (handleSeries[i] < handleSeries[i - 1]) nonDecreasing = false;
    netGrowth = handleSeries[handleSeries.length - 1] - handleSeries[0];
    monotonicGrowth = nonDecreasing && netGrowth > 0;
  }
  // A softer "clearly trending up" check (least-squares slope) in case it's not PERFECTLY
  // non-decreasing but still climbs -- crush-weld churn creating/destroying constraints every cycle
  // could plausibly leak a SMALL amount per cycle with some noise rather than a clean monotonic stair.
  function slope(ys) {
    const n = ys.length;
    const xs = ys.map((_, i) => i);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return den === 0 ? 0 : num / den;
  }
  const handleSlopePerCycle = handleSeries.length >= 5 ? slope(handleSeries) : null;
  if (monotonicGrowth) {
    findings.push({ severity: 'major', issue: 'liveHandleCount grew monotonically across the 50-cycle soak and never came back down (segment-weld churn leak candidate)', first: handleSeries[0], last: handleSeries[handleSeries.length - 1], netGrowth });
  } else if (handleSlopePerCycle !== null && handleSlopePerCycle > 0.5) {
    findings.push({ severity: 'major', issue: 'liveHandleCount trended clearly upward (least-squares) across the soak even without being perfectly monotonic', handleSlopePerCycle, first: handleSeries[0], last: handleSeries[handleSeries.length - 1] });
  }

  const summary = {
    seed: SEED, cyclesRun: rows.length, cyclesRequested: CYCLES, wasmDead, baselineFeatureBodyCount,
    handleSeriesFirst: handleSeries[0] ?? null, handleSeriesLast: handleSeries[handleSeries.length - 1] ?? null,
    handleNetGrowth: netGrowth, handleSlopePerCycle, monotonicGrowth,
    totalConsoleErrors: h.consoleErrors.length, totalPageErrors: h.pageErrors.length, findings,
  };
  writeJson('soak-rows.json', rows);
  writeJson('soak-summary.json', summary);
  console.log('[soak] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[soak] FATAL', err);
  process.exit(2);
});
