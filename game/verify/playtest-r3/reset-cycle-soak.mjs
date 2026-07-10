// ENDURANCE SOAK 1/2: 50-CYCLE RESET SOAK against the CURRENT compound-in-forest layout (ported
// pattern from playtest-soak/run1-reset-cycle-soak.mjs, which targeted the OLD flat 400m world and is
// now coordinate-stale). Each cycle: pick a seeded scenario (wall-crash / brick-wall / shed-collapse /
// barrel-chain / tree-hit / kicker-ramp), run it, settle, resetWorld(), then assert PRISTINE state:
//   - featureBodyCount back to the session baseline
//   - liveHandleCount not growing without bound across the whole run (monotonic-growth check)
//   - occupants fully re-seated (0 ejected)
//   - wheels all attached
//   - every destructible/building displacement ~0 (barrels/collapse/brick-wall all physically reset)
//   - buildings collapsing/broken-joint counts back to 0
//   - audio live-node count not growing without bound (audio-on throughout, per the run brief)
//   - telemetry all-finite (NaN guard)
//
// Drive-toward gain is 0.7 throughout (not the naive 1.4-1.7 several early scripts in this dir first
// tried) -- see diag-brick.mjs: a higher gain combined with a big simultaneous heading change at speed
// produces an oscillating-steer instability that stalls the car in place with zero material contact
// anywhere. The 'kicker' scenario deliberately uses x=0 (the ramp's own centerline) since THIS soak
// wants to know how often driving over it strands the car and whether resetWorld() always recovers it
// regardless (see this dir's diag-gate*.mjs: a confirmed ~1/3 permanent-stall rate under repeated
// identical throttle=1/steer=0 runs, unrecoverable by reverse -- only resetWorld()/resetCar() frees it).
//
// Usage: node verify/playtest-r3/reset-cycle-soak.mjs
import { launchHarness, sleep, allFinite, writeJson, mulberry32, DRIVE_TOWARD_SNIPPET, STRAIGHT_RUN_SNIPPET } from './lib.mjs';

const CYCLES = 50;
const SEED = 0xc0ffee;
const SCENARIOS = ['wall', 'brick', 'shed', 'barrels', 'tree', 'kicker'];

async function main() {
  const h = await launchHarness({ previewPort: 4820, cdpPort: 9820, label: 'soak-reset-cycle' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);
  await evalExpr(STRAIGHT_RUN_SNIPPET);
  const rng = mulberry32(SEED);

  const rows = [];
  const findings = [];
  let baselineFeatureBodyCount = null;
  let wasmDead = false;
  let kickerStalls = 0;
  let kickerRuns = 0;

  async function settle() {
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(180); "ok"'); // ~3s @ 60Hz
  }

  async function runScenarioOnce(kind) {
    if (kind === 'wall') {
      const kmh = Math.round(70 + rng() * 60);
      await evalExpr(`window.__GAME__.spawnTestWall(25); window.__GAME__.crash(${kmh}); 'ok'`);
      await evalExpr('window.__GAME__.stepN(220); "ok"');
      return { kind, kmh };
    }
    if (kind === 'brick') {
      const r = await evalExpr('window.__driveToward(16, 24, 500, 1.2, 0.85, 0.7, 90, 30)');
      return { kind, steps: r.steps, impactSpeedKmh: r.maxSpeedKmh };
    }
    if (kind === 'shed') {
      await evalExpr('window.__driveToward(-26, 27, 700, 4, 0.6, 0.7, 60, 30)');
      const r = await evalExpr('window.__driveToward(-30, 33, 500, 1.2, 0.9, 0.7, 60, 30)');
      let collapsing = await evalExpr("window.__GAME__.features.buildings.collapsingBodyCountFor('shed')");
      for (let a = 0; a < 3 && collapsing <= 0; a++) {
        await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(60); 'ok'");
        collapsing = await evalExpr("window.__GAME__.features.buildings.collapsingBodyCountFor('shed')");
      }
      return { kind, steps: r.steps, collapsingAtImpact: collapsing };
    }
    if (kind === 'barrels') {
      const r = await evalExpr('window.__driveToward(16, 33, 700, 1.5, 0.85, 0.7, 100, 30)');
      await evalExpr('window.__GAME__.stepN(150); "ok"'); // real fixed-step time for the chain's staggered fuses
      return { kind, steps: r.steps, impactSpeedKmh: r.maxSpeedKmh };
    }
    if (kind === 'tree') {
      // Rotate through the 3 hero sites across cycles (seeded pick) -- SAPLING (-110,20) is directly
      // reachable; MID (-72,-40) / LARGE (-92,-8) sit south of spawn so are staged from further south
      // first (their kept-clear corridor is from -Z), same technique as battery.mjs.
      const which = rng();
      if (which < 0.34) {
        const r = await evalExpr('window.__driveToward(-110, 20, 900, 3, 0.7, 0.7, 60, 30)');
        return { kind, which: 'sapling', steps: r.steps };
      } else if (which < 0.67) {
        await evalExpr('window.__driveToward(-72, -58, 1200, 5, 0.6, 0.7, 55, 40)');
        await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0.6, steer: 0, handbrake: false }); window.__GAME__.stepN(90); "ok"');
        const r = await evalExpr('window.__driveToward(-72, -40, 700, 1.5, 0.65, 0.8, 30, 20)');
        return { kind, which: 'mid', steps: r.steps };
      } else {
        await evalExpr('window.__driveToward(-92, -30, 1000, 5, 0.6, 0.7, 60, 40)');
        await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0.6, steer: 0, handbrake: false }); window.__GAME__.stepN(90); "ok"');
        const r = await evalExpr('window.__driveToward(-92, -8, 500, 1.5, 0.65, 0.8, 40, 20)');
        return { kind, which: 'large', steps: r.steps };
      }
    }
    // kicker -- deliberately x=0 (the ramp's own line); see header comment.
    const r = await evalExpr('window.__straightRun(400, 1, 0)');
    kickerRuns++;
    if (r.finalPos && r.finalPos.z < 53 && r.speedKmh < 1) kickerStalls++;
    return { kind, steps: r.steps, finalZ: r.finalPos?.z, finalSpeedKmh: r.speedKmh };
  }

  for (let cycle = 0; cycle < CYCLES && !wasmDead; cycle++) {
    const kind = SCENARIOS[Math.floor(rng() * SCENARIOS.length)];
    const errBefore = h.consoleErrors.length;
    const audioBefore = await evalExpr('window.__GAME__.audioDebug()').catch(() => null);
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
      findings.push({ cycle, kind, severity: 'blocker', issue: 'wasm-trap-or-exception', isKnownOob, trapMsg });
      wasmDead = true;
      rows.push({ cycle, kind, trapped: true, trapMsg });
      break;
    }

    let resetOk = true;
    let resetErr = null;
    try {
      await evalExpr("window.__GAME__.resetWorld(); 'ok'");
      await evalExpr('window.__GAME__.stepN(10); "ok"');
    } catch (err) {
      resetOk = false;
      resetErr = String(err && err.message ? err.message : err);
      wasmDead = true;
    }

    let liveHandles = null, featureBodies = null, seatStates = null, wheelStates = null,
      destructibleDisp = null, buildingsDisp = null, collapsingTotal = null, brokenTotal = null,
      audioAfter = null;
    if (resetOk) {
      liveHandles = await evalExpr('window.__GAME__.liveHandleCount()');
      featureBodies = await evalExpr('window.__GAME__.featureBodyCount()');
      seatStates = await evalExpr('window.__GAME__.features.occupants.seatStates()');
      const damage = (await evalExpr('window.__GAME__.telemetry')).damage;
      wheelStates = damage.wheelStates;
      destructibleDisp = await evalExpr('window.__GAME__.destructibleDisplacements()');
      collapsingTotal = await evalExpr('window.__GAME__.features.buildings.totalCollapsingBodyCount()');
      brokenTotal = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
      audioAfter = await evalExpr('window.__GAME__.audioDebug()').catch(() => null);
    }

    const errAfter = h.consoleErrors.length;
    const newErrors = errAfter - errBefore;
    const ejectedCount = seatStates ? seatStates.filter((s) => s.ejected).length : null;
    const detachedCount = wheelStates ? Object.values(wheelStates).filter((s) => s === 'detached').length : null;
    const maxDestructibleDisp = destructibleDisp && destructibleDisp.length ? Math.max(...destructibleDisp) : null;

    if (baselineFeatureBodyCount === null && featureBodies !== null) baselineFeatureBodyCount = featureBodies;

    const row = {
      cycle, kind, scenarioResult, resetOk, resetErr, liveHandles, featureBodies, ejectedCount,
      detachedCount, maxDestructibleDisp, collapsingTotal, brokenTotal,
      audioLiveNodeCount: audioAfter ? audioAfter.liveNodeCount : null,
      newConsoleErrors: newErrors,
      telemetryFinite: allFinite(seatStates) && allFinite(wheelStates) && allFinite(destructibleDisp),
    };
    rows.push(row);

    if (!resetOk) findings.push({ cycle, kind, severity: 'blocker', issue: 'resetWorld/stepN threw', resetErr });
    if (featureBodies !== null && baselineFeatureBodyCount !== null && featureBodies !== baselineFeatureBodyCount)
      findings.push({ cycle, kind, severity: 'major', issue: 'featureBodyCount drifted from baseline', baseline: baselineFeatureBodyCount, got: featureBodies });
    if (ejectedCount !== null && ejectedCount !== 0) findings.push({ cycle, kind, severity: 'major', issue: 'occupants not fully re-seated after reset', ejectedCount });
    if (detachedCount !== null && detachedCount !== 0) findings.push({ cycle, kind, severity: 'major', issue: 'wheel(s) detached after reset', detachedCount });
    if (maxDestructibleDisp !== null && maxDestructibleDisp >= 0.05) findings.push({ cycle, kind, severity: 'major', issue: 'destructible (incl. barrels) displacement >=0.05m after reset', maxDestructibleDisp });
    if (collapsingTotal !== null && collapsingTotal !== 0) findings.push({ cycle, kind, severity: 'blocker', issue: 'collapsingBodyCount nonzero after resetWorld()', collapsingTotal });
    if (brokenTotal !== null && brokenTotal !== 0) findings.push({ cycle, kind, severity: 'blocker', issue: 'brokenJointCount nonzero after resetWorld()', brokenTotal });
    if (!row.telemetryFinite) findings.push({ cycle, kind, severity: 'blocker', issue: 'non-finite telemetry after cycle' });
    if (newErrors > 0) findings.push({ cycle, kind, severity: 'minor', issue: 'console errors during cycle', newErrors });

    console.log(
      `[soak1] cycle ${cycle} kind=${kind} liveHandles=${liveHandles} featureBodies=${featureBodies} ejected=${ejectedCount} detached=${detachedCount} maxDisp=${maxDestructibleDisp?.toFixed?.(4)} collapsing=${collapsingTotal} broken=${brokenTotal} audioNodes=${row.audioLiveNodeCount} newErrors=${newErrors}`,
    );
  }

  const handleSeries = rows.filter((r) => r.liveHandles != null).map((r) => r.liveHandles);
  const audioSeries = rows.filter((r) => r.audioLiveNodeCount != null).map((r) => r.audioLiveNodeCount);
  function monotonicGrowthCheck(series, label, minLen = 5) {
    if (series.length < minLen) return null;
    let nonDecreasing = true;
    for (let i = 1; i < series.length; i++) if (series[i] < series[0] * 0.98) nonDecreasing = false; // allow tiny noise
    const netGrowth = series[series.length - 1] - series[0];
    const grew = nonDecreasing && netGrowth > Math.max(2, series[0] * 0.05);
    if (grew) findings.push({ severity: 'major', issue: `${label} grew across the soak and never came back down`, first: series[0], last: series[series.length - 1], netGrowth });
    return { first: series[0], last: series[series.length - 1], netGrowth, grew };
  }
  const handleGrowth = monotonicGrowthCheck(handleSeries, 'liveHandleCount');
  const audioGrowth = monotonicGrowthCheck(audioSeries, 'audio liveNodeCount');

  const summary = {
    seed: SEED, cyclesRun: rows.length, cyclesRequested: CYCLES, wasmDead,
    baselineFeatureBodyCount, handleGrowth, audioGrowth,
    kickerStallRate: kickerRuns > 0 ? `${kickerStalls}/${kickerRuns}` : 'n/a',
    totalConsoleErrors: h.consoleErrors.length, totalPageErrors: h.pageErrors.length, findings,
  };
  writeJson('reset-cycle-soak-rows.json', rows);
  writeJson('reset-cycle-soak-summary.json', summary);
  console.log('[soak1] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[soak1] FATAL', err);
  process.exit(2);
});
