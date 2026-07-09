// PLAYTEST scenario 9 (the big one): ~12 minutes of simulated time via stepN batches interleaved with
// crashes/resets/drives, ~45 cycles. Tracks per-cycle JS heap (performance.memory.usedJSHeapSize,
// after an explicit CDP HeapProfiler.collectGarbage() so readings aren't just GC-timing noise),
// liveHandleCount, NaN checks, and any uncaught exception -- logged to verify/playtest/soak.csv.
// FAILS if: any uncaught exception that isn't the already-documented wasm OOB trap (see
// repro-oob.mjs), the JS heap grows monotonically without plateau (leak), or any NaN appears.
//
// The battery (battery.mjs) already found the wasm "memory access out of bounds" trap recurs
// whenever the car sustains heavy wedged damage; this soak deliberately mixes moderate single-wall
// crashes with periodic full resets (not pure escalating damage) to represent a realistic extended
// play session, but is wired with the same recoverIfDead() resilience so a recurrence here doesn't
// abort the whole soak -- and is called out explicitly in the summary either way, per the brief.
//
// Usage: node verify/playtest/soak.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHarness, allFinite, sleep, pingStepAlive, OUT_DIR, writeJson } from './lib.mjs';

const CYCLES = 45;
const STEPS_PER_CYCLE = 960; // 16s sim time @ 60Hz -> 45*16s = 720s = 12 minutes

async function main() {
  let h = await launchHarness({ previewPort: 4700, cdpPort: 9700, width: 1280, height: 720, label: 'soak' });
  await h.send('HeapProfiler.enable');
  let relaunchCount = 0;
  const relaunchLog = [];
  const allConsoleErrors = [];
  const allPageErrors = [];

  const evalExpr = (expr) => h.evalExpr(expr);
  const rows = [];
  let oobRecurred = false;
  let anyOtherException = false;
  let anyNaN = false;

  async function heapMB() {
    await h.send('HeapProfiler.collectGarbage').catch(() => {});
    const v = await evalExpr('performance.memory ? performance.memory.usedJSHeapSize : -1');
    return v > 0 ? v / (1024 * 1024) : null;
  }

  async function recoverIfDead(cycleLabel) {
    const alive = await pingStepAlive(evalExpr).catch(() => ({ stepOk: false, error: 'ping itself threw' }));
    if (alive.stepOk) return false;
    const isKnownOob = /memory access out of bounds/i.test(alive.error || '');
    if (isKnownOob) oobRecurred = true;
    else anyOtherException = true;
    console.log(`\n*** [soak] wasm module DEAD after ${cycleLabel} (${isKnownOob ? 'KNOWN wasm-OOB trap' : 'OTHER/unexpected error'}): ${alive.error} -- relaunching ***\n`);
    relaunchLog.push({ after: cycleLabel, error: alive.error, isKnownOob });
    allConsoleErrors.push(...h.consoleErrors);
    allPageErrors.push(...h.pageErrors);
    relaunchCount++;
    await h.close();
    // Retry the relaunch itself a few times -- this sandbox has shown occasional transient
    // "preview server never came up" flakiness unrelated to the game (see lib.mjs's waitForHttp doc
    // comment); a fresh port each attempt sidesteps any lingering listener from the previous try.
    let launched = false;
    let lastErr;
    for (let attempt = 0; attempt < 4 && !launched; attempt++) {
      try {
        h = await launchHarness({ previewPort: 4700 + relaunchCount * 10 + attempt, cdpPort: 9700 + relaunchCount * 10 + attempt, width: 1280, height: 720, label: `soak-r${relaunchCount}` });
        launched = true;
      } catch (err) {
        lastErr = err;
        console.log(`[soak] relaunch attempt ${attempt + 1} failed: ${err.message} -- retrying`);
      }
    }
    if (!launched) throw new Error(`could not relaunch harness after wasm trap: ${lastErr?.message}`);
    await h.send('HeapProfiler.enable');
    return true;
  }

  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const heap0 = await heapMB();
  console.log(`[soak] starting. initial heap: ${heap0?.toFixed(2)}MB`);

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const action = cycle % 5 === 4 ? 'full-reset' : cycle % 3 === 0 ? 'crash-wall' : cycle % 3 === 1 ? 'free-drive' : 'crash-ramp-lane';
    let cycleError = null;
    try {
      if (action === 'full-reset') {
        await evalExpr('window.__GAME__.resetWorld(); "ok"');
        await evalExpr(`(() => { const g = window.__GAME__; g.setInput({throttle:1,brake:0,steer:0,handbrake:false}); g.stepN(${STEPS_PER_CYCLE}); g.setInput({throttle:0,brake:0,steer:0,handbrake:false}); return 'ok'; })()`);
      } else if (action === 'crash-wall') {
        await evalExpr('window.__GAME__.crash(70); "ok"');
        await evalExpr(`window.__GAME__.stepN(${STEPS_PER_CYCLE}); "ok"`);
      } else if (action === 'crash-ramp-lane') {
        await evalExpr('window.__GAME__.crash(55); "ok"');
        await evalExpr(`(() => {
          const g = window.__GAME__;
          for (let i = 0; i < ${STEPS_PER_CYCLE}; i++) {
            const t = g.telemetry;
            const steer = Math.max(-1, Math.min(1, ((-11) - t.chassisPos.x) * 0.1));
            g.setInput({ throttle: t.speedKmh < 60 ? 1 : 0, brake: 0, steer, handbrake: false });
            g.stepN(1);
          }
          return 'ok';
        })()`);
      } else {
        // free-drive: gentle oscillation, moderate speed target
        await evalExpr(`(() => {
          const g = window.__GAME__;
          for (let i = 0; i < ${STEPS_PER_CYCLE}; i++) {
            const t = g.telemetry;
            const steer = Math.sin(i / 70) * 0.12;
            g.setInput({ throttle: t.speedKmh < 45 ? 1 : 0, brake: 0, steer, handbrake: false });
            g.stepN(1);
          }
          return 'ok';
        })()`);
      }
    } catch (err) {
      cycleError = String((err && err.message) || err);
    }

    const relaunched = await recoverIfDead(`cycle ${cycle} (${action})`);
    if (relaunched) {
      await evalExpr("window.__GAME__.resetWorld(); 'ok'").catch(() => {});
    }

    let telemetry = null;
    let telemetryError = null;
    try {
      telemetry = await evalExpr('window.__GAME__.telemetry');
    } catch (err) {
      telemetryError = String((err && err.message) || err);
    }
    const nanHere = telemetry ? !allFinite(telemetry) : false;
    if (nanHere) anyNaN = true;
    if (cycleError && !/memory access out of bounds/i.test(cycleError)) anyOtherException = true;

    const liveHandles = await evalExpr('window.__GAME__.liveHandleCount()').catch(() => null);
    const heap = await heapMB();
    const row = {
      cycle,
      action,
      heapMB: heap !== null ? Number(heap.toFixed(2)) : null,
      liveHandleCount: liveHandles,
      speedKmh: telemetry ? Number(telemetry.speedKmh.toFixed(1)) : null,
      nan: nanHere,
      relaunched,
      cycleError: cycleError ?? '',
      telemetryError: telemetryError ?? '',
    };
    rows.push(row);
    console.log(`[soak] cycle ${cycle.toString().padStart(2)} action=${action.padEnd(15)} heap=${row.heapMB}MB handles=${row.liveHandleCount} speed=${row.speedKmh} nan=${nanHere} relaunched=${relaunched}${cycleError ? ' ERROR=' + cycleError.slice(0, 80) : ''}`);
  }

  allConsoleErrors.push(...h.consoleErrors);
  allPageErrors.push(...h.pageErrors);

  // ---- CSV ----
  const csvHeader = 'cycle,action,heapMB,liveHandleCount,speedKmh,nan,relaunched,cycleError\n';
  const csvBody = rows
    .map((r) => `${r.cycle},${r.action},${r.heapMB ?? ''},${r.liveHandleCount ?? ''},${r.speedKmh ?? ''},${r.nan},${r.relaunched},"${r.cycleError.replace(/"/g, "'").slice(0, 120)}"`)
    .join('\n');
  writeFileSync(path.join(OUT_DIR, 'soak.csv'), csvHeader + csvBody + '\n');

  // ---- Heap plateau check: compare mean of the first quarter of cycles vs the last quarter ----
  const heapValues = rows.map((r) => r.heapMB).filter((v) => v !== null);
  const q = Math.max(1, Math.floor(heapValues.length / 4));
  const firstQuarterMean = heapValues.slice(0, q).reduce((a, b) => a + b, 0) / q;
  const lastQuarterMean = heapValues.slice(-q).reduce((a, b) => a + b, 0) / q;
  const heapGrowthRatio = firstQuarterMean > 0 ? lastQuarterMean / firstQuarterMean : 1;
  // Monotonic-without-plateau check: are the LAST quarter's cycle-over-cycle heap deltas ALL positive
  // (never reclaimed even right after an explicit collectGarbage())? A healthy GC'd heap should show
  // at least some decreases/plateauing even under steady load.
  const lastQuarterVals = heapValues.slice(-q);
  const everDecreasedInLastQuarter = lastQuarterVals.some((v, i) => i > 0 && v < lastQuarterVals[i - 1]);
  const monotonicLeak = heapGrowthRatio > 1.5 && !everDecreasedInLastQuarter;

  const handleValues = rows.map((r) => r.liveHandleCount).filter((v) => v !== null);
  const handlesFlat = handleValues.length > 0 && Math.max(...handleValues) - Math.min(...handleValues.slice(-Math.max(1, Math.floor(handleValues.length / 3)))) < 50;

  const verdict = anyOtherException || anyNaN || monotonicLeak ? 'FAIL' : 'PASS';

  const summary = {
    cycles: CYCLES,
    stepsPerCycle: STEPS_PER_CYCLE,
    simSecondsTotal: CYCLES * STEPS_PER_CYCLE / 60,
    heapStartMB: heap0 !== null ? Number(heap0.toFixed(2)) : null,
    heapEndMB: rows[rows.length - 1]?.heapMB ?? null,
    heapFirstQuarterMeanMB: Number(firstQuarterMean.toFixed(2)),
    heapLastQuarterMeanMB: Number(lastQuarterMean.toFixed(2)),
    heapGrowthRatio: Number(heapGrowthRatio.toFixed(3)),
    everDecreasedInLastQuarter,
    monotonicLeakSuspected: monotonicLeak,
    liveHandleCountFirst: handleValues[0] ?? null,
    liveHandleCountLast: handleValues[handleValues.length - 1] ?? null,
    handlesFlat,
    wasmOobRecurred: oobRecurred,
    otherUncaughtExceptions: anyOtherException,
    anyNaNDetected: anyNaN,
    harnessRelaunches: relaunchCount,
    relaunchLog,
    consoleErrorCount: allConsoleErrors.length,
    pageErrorCount: allPageErrors.length,
    verdict,
  };

  writeJson('soak-results.json', { summary, rows, consoleErrors: allConsoleErrors, pageErrors: allPageErrors });
  console.log('\n\n========== SOAK SUMMARY ==========');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWASM OOB RECURRED DURING SOAK: ${oobRecurred ? 'YES' : 'NO'}`);
  console.log(`VERDICT: ${verdict}`);

  await h.close();
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error('[soak] FATAL', err);
  process.exit(1);
});
