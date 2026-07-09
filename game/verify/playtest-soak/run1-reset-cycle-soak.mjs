// ENDURANCE SOAK run 1: RESET CYCLE SOAK -- 50 cycles of {pick a seeded-random crash scenario, let it
// settle ~3s, resetWorld()}, asserting pristine post-reset state every cycle. Reuses the CDP/vite-
// preview harness from verify/playtest/lib.mjs (read-only import, no edits to that file) and the
// proven heading-P-controller drive technique from verify/feature-trees.mjs / feature-buildings.mjs
// (copied verbatim into DRIVE_TOWARD_SNIPPET below -- these are OWNED-PATH scripts, not edits to
// those files).
//
// Scenario menu (deterministic seeded order via mulberry32, same algorithm the trees feature itself
// uses -- see world/features/trees/tuning.ts):
//   'wall'   -- spawnTestWall(25) + crash(80..140 seeded) + coast to settle.
//   'brick'  -- drive toward BRICK_WALL_CENTER (68,20) (buildings feature, world/features/buildings/tuning.ts).
//   'tree'   -- drive toward LARGE_SITES[0] (-66,12) (trees feature, static-trunk stop).
//   'kicker' -- drive straight ahead over the kicker ramp (world/tuning.ts RAMP_CONFIGS 'kicker' at
//               x=0, backZ=43) and land.
//
// Usage: node verify/playtest-soak/run1-reset-cycle-soak.mjs
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchHarness, sleep, allFinite, gameRoot } from '../playtest/lib.mjs';

const OUT_DIR = path.join(gameRoot, 'verify', 'playtest-soak');
mkdirSync(OUT_DIR, { recursive: true });
function writeJson(name, obj) {
  const p = path.join(OUT_DIR, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
const CYCLES = 50;
const SEED = 0xc0ffee;

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

// Same heading-proportional-controller technique as verify/feature-trees.mjs's DRIVE_TOWARD_SNIPPET
// (copied here verbatim -- see that file's doc comment for the full calibration history/speed-cap
// rationale post vehicle-retune commit e4b9790).
const DRIVE_TOWARD_SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain, speedCapKmh) {
  const cap = speedCapKmh === undefined ? Infinity : speedCapKmh;
  function yawOf(q) {
    const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
    const fwd = {
      x: 0 + q.w * t.x + (q.y * t.z - q.z * t.y),
      y: 0 + q.w * t.y + (q.z * t.x - q.x * t.z),
      z: 1 + q.w * t.z + (q.x * t.y - q.y * t.x),
    };
    return Math.atan2(fwd.x, fwd.z);
  }
  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  let i = 0;
  for (; i < maxSteps; i++) {
    const t = window.__GAME__.telemetry;
    const p = t.chassisPos;
    const dist = Math.hypot(p.x - targetX, p.z - targetZ);
    if (dist < stopDist) break;
    const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
    const currentYaw = yawOf(t.chassisQuat);
    const err = wrap(desiredYaw - currentYaw);
    const steer = Math.max(-1, Math.min(1, -err * gain));
    const effectiveThrottle = t.speedKmh > cap ? 0 : throttle;
    window.__GAME__.setInput({ throttle: effectiveThrottle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  return { steps: i };
};
'ok';
`;

const rng = mulberry32(SEED);
const SCENARIOS = ['wall', 'brick', 'tree', 'kicker'];

async function main() {
  const h = await launchHarness({ previewPort: 4720, cdpPort: 9720, label: 'soak-run1' });
  const evalExpr = h.evalExpr;
  await evalExpr(DRIVE_TOWARD_SNIPPET);

  const rows = [];
  const findings = [];
  let baselineFeatureBodyCount = null;
  let wasmDead = false;

  async function settle() {
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(180); "ok"'); // ~3s @ 60Hz
  }

  async function runScenarioOnce(kind, cycle) {
    if (kind === 'wall') {
      const kmh = Math.round(80 + rng() * 60);
      await evalExpr(`window.__GAME__.spawnTestWall(25); window.__GAME__.crash(${kmh}); 'ok'`);
      await evalExpr('window.__GAME__.stepN(200); "ok"');
      return { kind, kmh };
    }
    if (kind === 'brick') {
      const r = await evalExpr('window.__driveToward(68, 20, 400, 3, 0.7, 1.6, 90)');
      return { kind, steps: r.steps };
    }
    if (kind === 'tree') {
      const r = await evalExpr('window.__driveToward(-66, 12, 400, 3, 0.7, 1.6, 90)');
      return { kind, steps: r.steps };
    }
    // kicker
    const r = await evalExpr('window.__driveToward(0, 55, 400, 3, 0.9, 1.5, 110)');
    await evalExpr('window.__GAME__.stepN(60); "ok"'); // extra airtime/landing settle
    return { kind, steps: r.steps };
  }

  for (let cycle = 0; cycle < CYCLES && !wasmDead; cycle++) {
    const kind = SCENARIOS[Math.floor(rng() * SCENARIOS.length)];
    const errBefore = h.consoleErrors.length;
    let scenarioResult;
    let trapped = false;
    let trapMsg = null;
    try {
      scenarioResult = await runScenarioOnce(kind, cycle);
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

    let liveHandles = null,
      featureBodies = null,
      seatStates = null,
      wheelStates = null,
      displacements = null;
    if (resetOk) {
      liveHandles = await evalExpr('window.__GAME__.liveHandleCount()');
      featureBodies = await evalExpr('window.__GAME__.featureBodyCount()');
      seatStates = await evalExpr('window.__GAME__.features.occupants.seatStates()');
      const damage = (await evalExpr('window.__GAME__.telemetry')).damage;
      wheelStates = damage.wheelStates;
      displacements = await evalExpr('window.__GAME__.destructibleDisplacements()');
    }

    const errAfter = h.consoleErrors.length;
    const newErrors = errAfter - errBefore;
    const ejectedCount = seatStates ? seatStates.filter((s) => s.ejected).length : null;
    const detachedCount = wheelStates ? Object.values(wheelStates).filter((s) => s === 'detached').length : null;
    const maxDisp = displacements && displacements.length ? Math.max(...displacements) : null;

    if (baselineFeatureBodyCount === null && featureBodies !== null) baselineFeatureBodyCount = featureBodies;

    const row = {
      cycle,
      kind,
      scenarioResult,
      resetOk,
      resetErr,
      liveHandles,
      featureBodies,
      ejectedCount,
      detachedCount,
      maxDisp,
      newConsoleErrors: newErrors,
      telemetryFinite: allFinite(seatStates) && allFinite(wheelStates),
    };
    rows.push(row);

    // Per-cycle pristine assertions:
    if (!resetOk) findings.push({ cycle, kind, severity: 'blocker', issue: 'resetWorld/stepN threw', resetErr });
    if (featureBodies !== null && baselineFeatureBodyCount !== null && featureBodies !== baselineFeatureBodyCount)
      findings.push({ cycle, kind, severity: 'major', issue: 'featureBodyCount drifted from baseline', baseline: baselineFeatureBodyCount, got: featureBodies });
    if (ejectedCount !== null && ejectedCount !== 0) findings.push({ cycle, kind, severity: 'major', issue: 'occupants not 4/4 seated after reset', ejectedCount, seatStates });
    if (detachedCount !== null && detachedCount !== 0) findings.push({ cycle, kind, severity: 'major', issue: 'wheel(s) detached after reset', detachedCount, wheelStates });
    if (maxDisp !== null && maxDisp >= 0.05) findings.push({ cycle, kind, severity: 'major', issue: 'destructible displacement >=0.05m after reset', maxDisp });
    if (newErrors > 0) findings.push({ cycle, kind, severity: 'minor', issue: 'console errors during cycle', newErrors });

    console.log(
      `[run1] cycle ${cycle} kind=${kind} liveHandles=${liveHandles} featureBodies=${featureBodies} ejected=${ejectedCount} detached=${detachedCount} maxDisp=${maxDisp?.toFixed?.(4)} newErrors=${newErrors}`,
    );
  }

  // Monotonic-growth check on liveHandleCount across all successfully-completed cycles.
  const handleSeries = rows.filter((r) => r.liveHandles !== null && r.liveHandles !== undefined).map((r) => r.liveHandles);
  let monotonicGrowth = false;
  if (handleSeries.length >= 5) {
    // simple check: strictly non-decreasing across the whole series AND net growth beyond noise.
    let nonDecreasing = true;
    for (let i = 1; i < handleSeries.length; i++) if (handleSeries[i] < handleSeries[i - 1]) nonDecreasing = false;
    const netGrowth = handleSeries[handleSeries.length - 1] - handleSeries[0];
    monotonicGrowth = nonDecreasing && netGrowth > 0;
    if (monotonicGrowth) {
      findings.push({
        severity: 'major',
        issue: 'liveHandleCount grew monotonically across the reset-cycle soak and never came back down',
        first: handleSeries[0],
        last: handleSeries[handleSeries.length - 1],
        netGrowth,
        wallCyclesInRun: rows.filter((r) => r.kind === 'wall').length,
      });
    }
  }

  const summary = {
    seed: SEED,
    cyclesRun: rows.length,
    cyclesRequested: CYCLES,
    wasmDead,
    baselineFeatureBodyCount,
    handleSeriesFirst: handleSeries[0] ?? null,
    handleSeriesLast: handleSeries[handleSeries.length - 1] ?? null,
    monotonicGrowth,
    totalConsoleErrors: h.consoleErrors.length,
    totalPageErrors: h.pageErrors.length,
    findings,
  };
  writeJson('run1-reset-cycle-soak-rows.json', rows);
  writeJson('run1-reset-cycle-soak-summary.json', summary);
  console.log('[run1] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[run1] FATAL', err);
  process.exit(2);
});
