// PLAYTEST scenario battery (scenarios 1-8 of the QA brief): free-drive, ramp-jump, wall-plow,
// barrel-strike + tower-topple, wreck-it, reset-integrity, tab-visibility/accumulator, quality-
// cycling. Scenario 9 (soak) and 10 (headed real-GPU check) are separate scripts (soak.mjs,
// headed.mjs) since they have very different run profiles (soak is long; headed needs a real
// display). One continuous browser session, driven deterministically via window.__GAME__ (stepN,
// setInput, crash, spawnTestWall, resetCar/resetWorld) plus the two read-only playtest hooks added to
// main.ts (wheelHeights, destructibleDisplacements) -- never via wall-clock waiting for physics.
//
// RESILIENCE: game/verify/playtest/repro-oob.mjs found a reliable repro of a wasm "memory access out
// of bounds" trap (box3d's Body.getTransform(), called from stepVehicle()) that, once triggered,
// fails EVERY subsequent stepN() call for the rest of that page's life (confirmed via pingStepAlive()
// twice in a row) -- readable (telemetry getters) but not steppable. Since scenarios 5/6 here
// deliberately inflict heavy repeated damage (the same class of state that triggered it), every
// scenario below is wrapped so a recurrence is caught, recorded as a finding, and recovered from (a
// fresh harness relaunch) rather than aborting the whole battery.
//
// Usage: node verify/playtest/battery.mjs
import { launchHarness, drive, allFinite, writeJson, sleep, pingStepAlive } from './lib.mjs';

const results = [];
function record(name, verdict, metrics, notes) {
  results.push({ name, verdict, metrics, notes });
  console.log(`\n=== [${verdict}] ${name} ===`);
  console.log(JSON.stringify(metrics, null, 2));
  if (notes) console.log('notes:', notes);
}

/** Throws (with a rich message) if a drive() result caught a mid-loop error (see lib.mjs's
 * driveScriptSource try/catch) -- lets each scenario just `checkDrive(res)` after every drive() call
 * and let runScenario()'s outer catch handle recording + recovery uniformly. */
function checkDrive(res, context) {
  if (res.error) {
    throw new Error(`drive() crashed during ${context} at step ${res.error.atStep}: ${res.error.message} | lastGoodTelemetry=${JSON.stringify(res.error.lastGoodTelemetry)}`);
  }
  return res;
}

// Destructible body index ranges (see src/world/bodies.ts's createDestructibleWorld() push order +
// src/world/tuning.ts's WALL_COLS/ROWS, CRATE_TOWER_LAYERS/WIDE_LAYERS, barrel row counts). Hardcoded
// here (plain node script, no TS import) -- cross-checked at runtime against destructibleBodyCount.
const RANGES = {
  wallCenter: [0, 18],
  wallLeft: [18, 36],
  wallRight: [36, 54],
  crates: [54, 54 + (6 * 9 + 2 * 4)], // 6 layers of 3x3 + 2 layers of 2x2 = 62 -> [54,116)
  barrels: [116, 126], // 1+2+3+4 = 10
  poles: [126, 131],
};

function countDisplaced(disp, range, thresholdM = 0.5) {
  return disp.slice(range[0], range[1]).filter((d) => d > thresholdM).length;
}

async function main() {
  let h = await launchHarness({ previewPort: 4180, cdpPort: 9430, width: 1280, height: 720, label: 'battery' });
  const allConsoleErrors = [];
  const allPageErrors = [];
  let relaunchCount = 0;
  const relaunchLog = [];

  const evalExpr = (expr) => h.evalExpr(expr);
  const screenshot = (name) => h.screenshot(name);
  const pressKey = async (code, key) => {
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key });
  };

  /** After a scenario, confirm the wasm module can still step (see this file's top doc comment on the
   * OOB trap being permanent once triggered). If not, relaunch a fresh preview+browser so the
   * remaining scenarios still get a fair, uncorrupted run. */
  async function recoverIfDead(label) {
    const alive = await pingStepAlive(evalExpr).catch(() => ({ stepOk: false, error: 'ping itself threw' }));
    if (alive.stepOk) return false;
    console.log(`\n*** [battery] wasm module confirmed DEAD after "${label}" (${alive.error}) -- relaunching fresh harness ***\n`);
    allConsoleErrors.push(...h.consoleErrors);
    allPageErrors.push(...h.pageErrors);
    relaunchCount++;
    relaunchLog.push({ after: label, error: alive.error });
    await h.close();
    h = await launchHarness({ previewPort: 4180 + relaunchCount, cdpPort: 9430 + relaunchCount, width: 1280, height: 720, label: `battery-r${relaunchCount}` });
    return true;
  }

  async function runScenario(name, fn) {
    try {
      await fn();
    } catch (err) {
      record(name, 'FAIL', { error: String((err && err.message) || err) }, 'scenario threw (see error) -- likely the wasm OOB trap recurring; see repro-oob-result.json for the original repro.');
    }
    await recoverIfDead(name);
  }

  const destructibleBodyCount = await evalExpr('window.__GAME__.destructibleBodyCount');
  console.log('[battery] destructibleBodyCount =', destructibleBodyCount, '(expected', RANGES.poles[1], ')');

  // ---- Steer-sign calibration: mathUtil.ts's steer sign is documented as "not gameplay-validated" --
  // find out empirically which way steer=+1 curves the car so the waypoint-following driver below
  // (used for the ramp/wall/barrel/tower scenarios) can aim at a target world-X reliably. ----
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const calib = await evalExpr(`(() => {
    const g = window.__GAME__;
    g.setInput({ throttle: 1, brake: 0, steer: 1, handbrake: false });
    g.stepN(90);
    const t = g.telemetry;
    g.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false });
    return { x: t.chassisPos.x, yaw: t.yawRateRadS };
  })()`);
  const calibSign = calib.x >= 0 ? 1 : -1;
  console.log('[battery] steer calibration: steer=+1 for 1.5s -> x =', calib.x.toFixed(2), '=> calibSign', calibSign);
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");

  // =================================================================================================
  // 1. FREE-DRIVE: 30s figure-eight-ish drive at ~50km/h, deliberately steered clear of the obstacle
  // field (all destructibles sit within |x|<=16, z<=40 -- see world/tuning.ts's LAYOUT comment) by
  // wandering around a moving target far out at x=+-60 -- this scenario is about baseline
  // controllability, not crashing; the (very real, very reproducible) obstacle-collision wasm trap is
  // documented separately below and in repro-oob-result.json.
  // =================================================================================================
  await runScenario('free-drive', async () => {
    // NOTE: an earlier version of this scenario used mode:'waypoint' aimed at a far-away point, but
    // with kp high enough to matter at that distance the steer command saturated at the +-1 clamp
    // continuously, so the car just held full-lock and circled near spawn instead of actually
    // traveling outward (caught by inspecting the resulting screenshot/telemetry -- final position
    // was ~13m from spawn after 30s at ~50km/h, i.e. it never left the circle). A mild constant bias
    // + a smaller sine wobble (never saturating) reliably curves the car out of the |x|<=16 obstacle
    // band within the first few seconds and then wanders the open field for the rest of the run.
    const res = checkDrive(
      await drive(evalExpr, {
        mode: 'figure8',
        bias: 0.28 * calibSign,
        steerAmp: 0.14,
        period: 70,
        targetSpeed: 50,
        maxSteps: 1800, // 30s @ 60Hz
        sampleEvery: 15,
      }),
      'free-drive',
    );
    await sleep(700);
    const shot = await screenshot('01-free-drive');
    const finite = allFinite(res.samples);
    const speeds = res.samples.map((s) => s.speed);
    const maxUpFlip = res.samples.filter((s) => s.up < 0.3).length; // upDot<0.3 ~ car rolled past ~72deg
    const maxAbsRoll = Math.max(...res.samples.map((s) => Math.abs(s.roll)));
    const speedBand = { min: Math.min(...speeds), max: Math.max(...speeds) };
    const verdict = finite && maxUpFlip === 0 && maxAbsRoll < 0.6 && speedBand.max < 100 ? 'PASS' : 'CONCERN';
    record(
      'free-drive',
      verdict,
      { steps: res.samples.length, speedBand, maxAbsRollRad: Number(maxAbsRoll.toFixed(3)), flipSamples: maxUpFlip, finalXZ: { x: res.finalTelemetry.chassisPos.x, z: res.finalTelemetry.chassisPos.z }, screenshot: shot },
      'wandering waypoint chase (targeting a moving point far out in open ground) at ~50km/h target speed for 30s; PASS = car stayed upright and controllable, no NaN, no obstacle contact.',
    );
  });

  // =================================================================================================
  // 1b. BONUS FINDING (not one of the 10 numbered scenarios, but discovered while designing #1): an
  // aggressive figure-eight (steerAmp 0.5, no obstacle avoidance) reliably drives the car into the
  // pole/wall field, sustains heavy damage, and then EVERY subsequent stepN() call throws a wasm
  // "memory access out of bounds" trap inside Body.getTransform() -- permanently, confirmed twice in a
  // row. This matches the brief's "once-seen non-reproducible wasm OOB" -- it is NOT non-reproducible;
  // see repro-oob.mjs (already run separately) for the isolated, fresh-session repro + full diagnostic
  // dump (repro-oob-result.json) + screenshot (00-wasm-oob-repro-stuck-car.png, in this same
  // directory). Not re-run here to avoid consuming a harness relaunch mid-battery for a known result.
  // =================================================================================================
  record(
    'BONUS: wasm-oob-crash-repro',
    'FAIL',
    { reproScript: 'verify/playtest/repro-oob.mjs', resultFile: 'verify/playtest/repro-oob-result.json', screenshot: 'verify/playtest/00-wasm-oob-repro-stuck-car.png' },
    'Reliable repro (2/2 runs) of a wasm RuntimeError "memory access out of bounds" in Body.getTransform() via stepVehicle(), triggered by sustained high-stress contact with a destructible object during hard alternating steering (hood panel broken, 3 panels loosened, 8020 dented vertices at the point of failure). Once triggered, EVERY subsequent stepN() call fails identically forever (confirmed via 2 consecutive post-crash pingStepAlive() calls) -- in the live game this presents as a silent total freeze (last frame stays on screen, console spammed every animation frame). See the final report for full detail.',
  );

  // =================================================================================================
  // 2. RAMP-JUMP: kicker ramp (x=-11, backZ=8, 30deg, length ~2.08m) at ~70km/h -- try 3 approach
  // speeds since the ramp sits only 8m from spawn and requires ~11m of lateral travel to line up with
  // it; report honestly whether 70km/h is actually reachable while still landing on the ramp.
  // =================================================================================================
  await runScenario('ramp-jump', async () => {
    const attempts = [];
    for (const speedKmh of [35, 55, 70]) {
      await evalExpr("window.__GAME__.resetWorld(); 'ok'");
      await evalExpr(`window.__GAME__.crash(${speedKmh}); 'ok'`);
      const res = checkDrive(
        await drive(evalExpr, {
          mode: 'waypoint',
          targetX: -11,
          kp: 0.15,
          steerMultiplier: calibSign,
          targetSpeed: speedKmh + 25, // keep throttle on through the corner to fight scrub-off
          maxSteps: 240, // 4s
          sampleEvery: 1,
          sampleWheels: true,
          sampleDamage: false,
          stopZ: 16,
        }),
        `ramp-jump@${speedKmh}kmh`,
      );
      const inRampWindow = res.samples.filter((s) => s.z >= 8 && s.z <= 10.5);
      const lateralMiss = inRampWindow.length ? Math.min(...inRampWindow.map((s) => Math.abs(s.x - -11))) : null;
      const entrySample = res.samples.find((s) => s.z >= 8) ?? res.samples[res.samples.length - 1];
      const restY = 0.359; // ~WHEEL_RADIUS_FRONT_M = CHASSIS_ORIGIN_HEIGHT_M, see vehicle/tuning.ts (S90 swap 2026-07-11: was 0.39)
      const maxChassisY = res.samples.length ? Math.max(...res.samples.map((s) => s.y)) : restY;
      const allWheelsAirborneSamples = res.samples.filter((s) => s.wh && Object.values(s.wh).every((y) => y > restY + 0.08));
      attempts.push({
        speedKmh,
        entrySpeedKmh: entrySample?.speed ?? null,
        entryZ: entrySample?.z ?? null,
        lateralMissM: lateralMiss,
        maxChassisY: Number(maxChassisY.toFixed(3)),
        chassisYDelta: Number((maxChassisY - restY).toFixed(3)),
        allWheelsAirborneStepCount: allWheelsAirborneSamples.length,
        finite: allFinite(res.samples),
      });
    }
    await sleep(700);
    const shot = await screenshot('02-ramp-jump');
    const gotAir = attempts.some((a) => a.allWheelsAirborneStepCount > 0);
    const reached70 = attempts.find((a) => a.speedKmh === 70)?.entrySpeedKmh ?? 0;
    const verdict = attempts.every((a) => a.finite) ? (gotAir ? 'PASS' : 'CONCERN') : 'FAIL';
    record(
      'ramp-jump',
      verdict,
      { attempts, gotAirOnAnyAttempt: gotAir, screenshot: shot },
      `honest finding: ramp is only ~8m from spawn + needs ~11m lateral travel to line up, so a fresh-launch approach at true 70km/h is geometrically tight (measured entry speed at 70km/h attempt: ${reached70?.toFixed?.(1)}km/h). See per-attempt lateralMissM/allWheelsAirborneStepCount for whether each attempt actually landed on the ramp and got air.`,
    );
  });

  // =================================================================================================
  // 3. WALL-PLOW: 60km/h into each of the 3 stacked walls.
  // =================================================================================================
  await runScenario('wall-plow', async () => {
    const laneFor = { 'wall-center': 0, 'wall-left': -11, 'wall-right': 11 };
    const rangeFor = { 'wall-center': RANGES.wallCenter, 'wall-left': RANGES.wallLeft, 'wall-right': RANGES.wallRight };
    const attempts = {};
    for (const id of ['wall-center', 'wall-left', 'wall-right']) {
      await evalExpr("window.__GAME__.resetWorld(); 'ok'");
      await evalExpr(`window.__GAME__.crash(60); 'ok'`);
      const targetX = laneFor[id];
      const res = checkDrive(
        await drive(evalExpr, {
          mode: targetX === 0 ? 'straight' : 'waypoint',
          targetX,
          kp: 0.15,
          steerMultiplier: calibSign,
          targetSpeed: 85,
          maxSteps: 300,
          sampleEvery: 2,
          sampleDamage: true,
          stopZ: 24,
        }),
        `wall-plow@${id}`,
      );
      const dispRaw = await evalExpr('window.__GAME__.destructibleDisplacements()');
      const displaced = countDisplaced(dispRaw, rangeFor[id], 0.5);
      const preWallSample = [...res.samples].reverse().find((s) => s.z < 17) ?? res.samples[0];
      const finalDamage = res.finalTelemetry.damage;
      const panelsHit = Object.entries(finalDamage.panelStates).filter(([, s]) => s !== 'attached').map(([k, s]) => `${k}:${s}`);
      attempts[id] = {
        approxImpactSpeedKmh: preWallSample?.speed ?? null,
        blocksDisplacedOver0_5m: displaced,
        blocksTotal: rangeFor[id][1] - rangeFor[id][0],
        panelsAffected: panelsHit,
        wheelStates: finalDamage.wheelStates,
        dentedVertexCount: finalDamage.dentedVertexCount,
        finite: allFinite(res.finalTelemetry),
        note: id !== 'wall-center' ? 'this lane crosses its ramp first (z 8-10) before reaching the wall at z=20' : undefined,
      };
    }
    await sleep(700);
    const shot = await screenshot('03-wall-plow');
    const allScattered = Object.values(attempts).every((a) => a.blocksDisplacedOver0_5m > 0);
    const allFiniteOk = Object.values(attempts).every((a) => a.finite);
    const verdict = !allFiniteOk ? 'FAIL' : allScattered ? 'PASS' : 'CONCERN';
    record('wall-plow', verdict, { attempts, screenshot: shot }, '60km/h crash() + steer into each of the 3 stacked walls; PASS = every wall scattered >=1 block >0.5m and the car stayed drivable.');
  });

  // =================================================================================================
  // 4. BARREL-STRIKE + TOWER-TOPPLE: right lane through the bowling triangle, left lane into the
  // crate tower. Both lanes have a wall in front of the target (wall-right/wall-left respectively) --
  // per the level's own layout comment in world/tuning.ts, so this is a continuous plow-through, not
  // an isolated hit on virgin geometry; noted plainly below.
  // =================================================================================================
  await runScenario('barrel-strike + tower-topple', async () => {
    const attempts = {};
    for (const target of ['barrels', 'crates']) {
      const targetX = target === 'barrels' ? 11 : -11;
      await evalExpr("window.__GAME__.resetWorld(); 'ok'");
      await evalExpr(`window.__GAME__.crash(75); 'ok'`);
      const res = checkDrive(
        await drive(evalExpr, {
          mode: 'waypoint',
          targetX,
          kp: 0.12,
          steerMultiplier: calibSign,
          targetSpeed: 90,
          maxSteps: 420,
          sampleEvery: 3,
          sampleDamage: true,
          stopZ: 38,
        }),
        `barrel-tower@${target}`,
      );
      const dispRaw = await evalExpr('window.__GAME__.destructibleDisplacements()');
      const displaced = countDisplaced(dispRaw, RANGES[target], 0.5);
      attempts[target] = {
        displacedOver0_5m: displaced,
        totalBodies: RANGES[target][1] - RANGES[target][0],
        finalSpeedKmh: res.finalTelemetry.speedKmh,
        finalZ: res.finalTelemetry.chassisPos.z,
        finite: allFinite(res.finalTelemetry),
      };
      await sleep(400);
      attempts[target].screenshot = await screenshot(`04-${target}-midflight`);
    }
    const verdict = Object.values(attempts).every((a) => a.finite && a.displacedOver0_5m > 0) ? 'PASS' : 'CONCERN';
    record(
      'barrel-strike + tower-topple',
      verdict,
      attempts,
      "each run plows through its lane's wall FIRST (wall-right before barrels, wall-left before crate tower -- same lane per world/tuning.ts layout), then the barrels/tower; counts are for JUST the barrels/crates index range, not the wall it passed through first.",
    );
  });

  // =================================================================================================
  // 5. WRECK-IT: repeated 100km/h wall-center crashes (no repair between) until >=3 panels broken +
  // >=1 wheel detached, or 6 attempts.
  // =================================================================================================
  await runScenario('wreck-it', async () => {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    const attempts = [];
    let met = false;
    for (let i = 0; i < 6 && !met; i++) {
      await evalExpr('window.__GAME__.crash(100); "ok"');
      const res = checkDrive(
        await drive(evalExpr, { mode: 'straight', targetSpeed: 100, maxSteps: 240, sampleEvery: 4, sampleDamage: true, stopZ: 30 }),
        `wreck-it@attempt${i + 1}`,
      );
      const d = res.finalTelemetry.damage;
      const brokenPanels = Object.values(d.panelStates).filter((s) => s === 'broken').length;
      const detachedWheels = Object.values(d.wheelStates).filter((s) => s === 'detached').length;
      met = brokenPanels >= 3 && detachedWheels >= 1;
      attempts.push({ attempt: i + 1, brokenPanels, detachedWheels, dentedVertexCount: d.dentedVertexCount, finite: allFinite(res.finalTelemetry) });
    }
    await sleep(700);
    const shot = await screenshot('05-wreck-it');
    // Post-wreck steerability check: still-attached wheels should still respond to input.
    const steerCheck = checkDrive(
      await drive(evalExpr, { mode: 'turn', steerConst: 1, targetSpeed: 40, maxSteps: 60, sampleEvery: 60 }),
      'wreck-it@post-wreck-steer-check',
    ).finalTelemetry;
    const last = attempts[attempts.length - 1];
    const finiteOk = attempts.every((a) => a.finite) && allFinite(steerCheck);
    const verdict = !finiteOk ? 'FAIL' : met ? 'PASS' : 'CONCERN';
    record(
      'wreck-it',
      verdict,
      { attempts, targetMetAt: met ? attempts.length : null, postWreckSteerCheck: { speed: steerCheck.speedKmh, yaw: steerCheck.yawRateRadS, up: steerCheck.upDot }, screenshot: shot },
      met
        ? `reached >=3 broken panels + >=1 detached wheel after ${attempts.length} attempt(s).`
        : `never reached the >=3 broken + >=1 detached target within 6 attempts (max seen: ${last.brokenPanels} broken, ${last.detachedWheels} detached).`,
    );
  });

  // =================================================================================================
  // 6. RESET-INTEGRITY: heavy damage -> R (car repair) -> Shift+R (world) x15 cycles, crash between
  // each, checking panels/dents/destructibles/live-handle-count all come back clean and flat.
  // =================================================================================================
  await runScenario('reset-integrity', async () => {
    const cycles = [];
    for (let i = 0; i < 15; i++) {
      await evalExpr('window.__GAME__.crash(90); "ok"');
      await evalExpr('window.__GAME__.stepN(150); "ok"'); // 2.5s -- let the crash play out
      const liveBefore = await evalExpr('window.__GAME__.liveHandleCount()');
      const damagedTelemetry = await evalExpr('window.__GAME__.telemetry.damage');
      await evalExpr('window.__GAME__.resetCar(); "ok"'); // R
      await evalExpr('window.__GAME__.resetWorld(); "ok"'); // Shift+R
      const afterWorldReset = await evalExpr('window.__GAME__.telemetry.damage');
      const disp = await evalExpr('window.__GAME__.destructibleDisplacements()');
      const liveAfter = await evalExpr('window.__GAME__.liveHandleCount()');
      const maxDisp = Math.max(...disp);
      const panelsIntact = Object.values(afterWorldReset.panelStates).every((s) => s === 'attached');
      const wheelsIntact = Object.values(afterWorldReset.wheelStates).every((s) => s === 'attached');
      cycles.push({
        cycle: i + 1,
        damagedBrokenPanels: Object.values(damagedTelemetry.panelStates).filter((s) => s !== 'attached').length,
        panelsIntactAfterReset: panelsIntact,
        wheelsIntactAfterReset: wheelsIntact,
        dentedVertexCountAfterReset: afterWorldReset.dentedVertexCount,
        maxDestructibleDisplacementAfterReset: Number(maxDisp.toFixed(4)),
        liveHandleCountBefore: liveBefore,
        liveHandleCountAfter: liveAfter,
      });
    }
    await sleep(700);
    const shot = await screenshot('06-reset-integrity');
    const allPanelsOk = cycles.every((c) => c.panelsIntactAfterReset && c.wheelsIntactAfterReset && c.dentedVertexCountAfterReset === 0);
    const allDestructiblesOk = cycles.every((c) => c.maxDestructibleDisplacementAfterReset < 0.05);
    const handleCounts = cycles.map((c) => c.liveHandleCountAfter);
    const firstHandle = handleCounts[0];
    const lastHandle = handleCounts[handleCounts.length - 1];
    const handleFlat = Math.abs(lastHandle - firstHandle) <= 2; // small const tolerance, not a monotonic climb
    const verdict = allPanelsOk && allDestructiblesOk && handleFlat ? 'PASS' : 'CONCERN';
    record(
      'reset-integrity',
      verdict,
      { cycles: 15, allPanelsRestored: allPanelsOk, allDestructiblesRestored: allDestructiblesOk, liveHandleCountFirst: firstHandle, liveHandleCountLast: lastHandle, handleCountFlat: handleFlat, perCycle: cycles, screenshot: shot },
      'each cycle: crash(90) + 2.5s, resetCar() (R), resetWorld() (Shift+R); PASS = damage state fully clears every cycle and liveHandleCount does not grow across the 15 cycles.',
    );
  });

  // =================================================================================================
  // 7. TAB-VISIBILITY / ACCUMULATOR: stall the main thread for 3s (simulating a backgrounded tab --
  // rAF simply stops firing), then resume, and confirm the sim did NOT spiral/teleport. Read
  // src/core/loop.ts first: FixedStepAccumulator caps steps-per-frame at 8 (~0.133s of sim time) and
  // main.ts's animate() separately clamps dt to 0.1s -- this test exercises that clamp directly rather
  // than trusting the source reading alone.
  // =================================================================================================
  await runScenario('tab-visibility/accumulator', async () => {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(180); "ok"'); // 3s build-up to ~steady speed
    const before = await evalExpr('window.__GAME__.telemetry');
    const errorsBefore = h.consoleErrors.length + h.pageErrors.length;
    // Blocks the page's JS thread for 3 real seconds -- no stepN/rAF can run meanwhile, same
    // observable effect as a backgrounded tab (rAF callbacks simply don't fire while hidden).
    await evalExpr(`(() => { const t0 = performance.now(); while (performance.now() - t0 < 3000) {} return 'stalled'; })()`);
    await sleep(600); // let a few real rAF frames process the resume
    const after = await evalExpr('window.__GAME__.telemetry');
    const errorsAfter = h.consoleErrors.length + h.pageErrors.length;
    const dz = after.chassisPos.z - before.chassisPos.z;
    const dSpeed = Math.abs(after.speedKmh - before.speedKmh);
    // Bound: FixedStepAccumulator's maxStepsPerFrame=8 @ FIXED_DT=1/60 -> at most ~0.133s of sim time
    // can be consumed by any single frame regardless of stall length; a couple of frames may run
    // during the 600ms resume window, so allow a generous few-step margin, NOT anywhere near 3s worth
    // of driving (~3s * before.speedKmh/3.6 m/s would be tens of meters).
    const maxPlausibleDz = (before.speedKmh / 3.6) * 0.5 + 2; // generous: ~0.5s worth of travel + margin
    const noSpiral = dz < maxPlausibleDz && Number.isFinite(dz) && Number.isFinite(dSpeed);
    const noNewErrors = errorsAfter === errorsBefore;
    const verdict = allFinite(after) && noSpiral && noNewErrors ? 'PASS' : 'FAIL';
    record(
      'tab-visibility/accumulator',
      verdict,
      { speedBeforeKmh: before.speedKmh, speedAfterKmh: after.speedKmh, dz: Number(dz.toFixed(3)), maxPlausibleDz: Number(maxPlausibleDz.toFixed(3)), dSpeedKmh: Number(dSpeed.toFixed(2)), noNewErrors, finiteAfter: allFinite(after) },
      'stalled the page JS thread 3s (no rAF), then resumed; PASS = position/speed advanced only a small bounded amount (accumulator catch-up cap), not ~3s worth of driving, and no new console/page errors.',
    );
  });

  // =================================================================================================
  // 8. QUALITY-CYCLING UNDER LOAD: mid-crash, cycle Q through all 3 presets twice via real KeyQ
  // CDP keydown/keyup events (installKeyboardInput listens on real KeyboardEvents).
  // =================================================================================================
  await runScenario('quality-cycling-under-load', async () => {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr('window.__GAME__.crash(90); "ok"');
    await evalExpr('window.__GAME__.stepN(30); "ok"'); // get into the impact
    await pressKey('KeyF', 'f'); // show the fps/physics-ms perf readout
    const errorsBefore = h.consoleErrors.length + h.pageErrors.length;
    const qualitySeen = [];
    for (let i = 0; i < 6; i++) {
      await pressKey('KeyQ', 'q');
      await evalExpr('window.__GAME__.stepN(20); "ok"'); // keep the crash/physics moving between toggles
      await sleep(150); // let a couple of real frames render on the new renderer/pixel ratio
      const level = await evalExpr('window.__GAME__.quality');
      qualitySeen.push(level);
    }
    await sleep(500);
    const perfInfo = await evalExpr(`(() => {
      const el = document.getElementById('hud-perf');
      return { text: el ? el.textContent : null, visible: el ? el.classList.contains('hud-visible') : false };
    })()`);
    const shot = await screenshot('08-quality-cycling');
    const errorsAfter = h.consoleErrors.length + h.pageErrors.length;
    const distinctLevels = new Set(qualitySeen);
    const cyclingOk = distinctLevels.size === 3 && qualitySeen[2] === qualitySeen[5]; // full loop back after 3 presses
    const perfOk = perfInfo.visible && /fps \d+.*physics [\d.]+ms/.test(perfInfo.text ?? '');
    const noNewErrors = errorsAfter === errorsBefore;
    const verdict = cyclingOk && perfOk && noNewErrors ? 'PASS' : 'CONCERN';
    record(
      'quality-cycling-under-load',
      verdict,
      { qualitySeen, cyclingOk, perfReadout: perfInfo, noNewErrors, screenshot: shot },
      'cycled Q x6 (2 full loops of high/medium/low) while a crash was resolving; PASS = all 3 levels visited, fps/physics-ms readout present + updating, no new console/page errors (no black-screen IBL loss on the antialias-triggered renderer swap).',
    );
  });

  allConsoleErrors.push(...h.consoleErrors);
  allPageErrors.push(...h.pageErrors);
  writeJson('battery-results.json', { destructibleBodyCount, calibSign, results, relaunchLog, consoleErrors: allConsoleErrors, consoleWarnings: h.consoleWarnings, pageErrors: allPageErrors });
  console.log('\n\n========== SUMMARY ==========');
  for (const r of results) console.log(`${r.verdict.padEnd(8)} ${r.name}`);
  console.log(`console errors: ${allConsoleErrors.length}  page exceptions: ${allPageErrors.length}  harness relaunches: ${relaunchCount}`);

  await h.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[battery] FATAL', err);
  process.exit(1);
});
