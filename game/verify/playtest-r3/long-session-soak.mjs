// ENDURANCE SOAK 2/2: >=12 REAL minutes of continuous scripted driving against the CURRENT
// compound-in-forest layout (ported pattern from playtest-soak/run2-long-session.mjs, which targeted
// the OLD flat 400m world and is now coordinate-stale). Drives via persistent setInput() + the game's
// own live requestAnimationFrame loop (real wall-clock time -- NOT window.__GAME__.stepN() batching),
// occasional 'R' car-repair (resetCar(), NOT resetWorld()), audio unlocked/on throughout (this dir's
// launchHarness() default) so the audio live-node count can be watched for a leak the whole session,
// same as the heap/fps/handle trends.
//
// Segment patterns (compound coordinates, world/tuning.ts + heightfield.ts):
//   'yard-weave'      -- gentle oscillating steer around the yard clutter (crates/poles/walls), x~[-20,20].
//   'gate-loop-drive'  -- steer toward x~4.5 (off BOTH ramps' footprints, see battery.mjs's
//                         'kicker-ramp-landing' finding) and out the gate onto the dirt loop.
//   'kicker-laps'      -- deliberately drive the x=0 kicker-ramp line -- exercises the ramp's known
//                         instability (battery.mjs's diag-gate*.mjs) repeatedly under REAL frame timing.
//   'perimeter-fast'   -- wide sweeping turn at high throttle out past the yard into the meadow.
//   'repair'           -- resetCar() (not resetWorld()) mid-session, per the run brief.
//
// Usage: node verify/playtest-r3/long-session-soak.mjs
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchHarness, sleep, allFinite, writeJson, mulberry32, gameRoot } from './lib.mjs';

const TOTAL_MS = 12.5 * 60_000; // 12.5 real minutes (>=12 min requested, small buffer)
const SEGMENT_MS = 30_000;
const SAMPLE_MS = 30_000;
const rng = mulberry32(0x1e55);
const PATTERNS = ['yard-weave', 'gate-loop-drive', 'kicker-laps', 'perimeter-fast', 'repair'];

async function main() {
  const h = await launchHarness({ previewPort: 4821, cdpPort: 9821, label: 'soak-long-session' });
  const { evalExpr } = h;

  async function fpsNum() {
    const txt = await evalExpr("document.getElementById('hud-perf') ? document.getElementById('hud-perf').textContent : null");
    const m = txt && /fps\s+(\d+)/.exec(txt);
    return m ? Number(m[1]) : null;
  }
  async function heapMB() {
    await h.send('HeapProfiler.collectGarbage').catch(() => {});
    const v = await evalExpr('performance.memory ? performance.memory.usedJSHeapSize : -1');
    return v > 0 ? v / (1024 * 1024) : null;
  }

  const samples = [];
  let lastSegment = null;
  let anyNaN = false;
  let wasmDead = false;
  let wasmError = null;
  let kickerStalls = 0;
  let kickerLapsRun = 0;
  const t0 = Date.now();
  let nextSegmentAt = 0;

  try {
    while (Date.now() - t0 < TOTAL_MS) {
      const elapsed = Date.now() - t0;
      if (elapsed >= nextSegmentAt) {
        const pattern = PATTERNS[Math.floor(rng() * PATTERNS.length)];
        lastSegment = pattern;
        console.log(`[soak2] t=${Math.round(elapsed / 1000)}s segment=${pattern}`);
        if (pattern === 'repair') {
          await evalExpr("window.__GAME__.resetCar(); 'ok'");
          await evalExpr("window.__GAME__.setInput({ throttle: 0.6, brake: 0, steer: 0, handbrake: false }); 'ok'");
        } else if (pattern === 'yard-weave') {
          const steer = (rng() - 0.5) * 1.0;
          await evalExpr(`window.__GAME__.setInput({ throttle: 0.5, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        } else if (pattern === 'gate-loop-drive') {
          await evalExpr("window.__GAME__.setInput({ throttle: 0.75, brake: 0, steer: 0.15, handbrake: false }); 'ok'"); // gentle bias toward x~4.5
        } else if (pattern === 'kicker-laps') {
          kickerLapsRun++;
          await evalExpr("window.__GAME__.resetCar(); window.__GAME__.setInput({ throttle: 0.9, brake: 0, steer: 0, handbrake: false }); 'ok'"); // x=0 line, straight at the kicker
        } else {
          const steer = (rng() - 0.5) * 0.5;
          await evalExpr(`window.__GAME__.setInput({ throttle: 1, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        }
        nextSegmentAt = elapsed + SEGMENT_MS;
      }

      const waitMs = Math.min(SAMPLE_MS, TOTAL_MS - (Date.now() - t0));
      if (waitMs > 0) await sleep(waitMs);

      const t = await evalExpr('window.__GAME__.telemetry');
      const lh = await evalExpr('window.__GAME__.liveHandleCount()');
      const fb = await evalExpr('window.__GAME__.featureBodyCount()');
      const audio = await evalExpr('window.__GAME__.audioDebug()').catch(() => null);
      const fps = await fpsNum();
      const heap = await heapMB();
      const finite = allFinite(t);
      if (!finite) anyNaN = true;
      if (lastSegment === 'kicker-laps' && t.speedKmh < 1 && t.chassisPos.z < 53) kickerStalls++;
      const sample = {
        tSec: Math.round((Date.now() - t0) / 1000),
        segment: lastSegment,
        speedKmh: t.speedKmh,
        chassisPos: t.chassisPos,
        finite,
        liveHandles: lh,
        featureBodies: fb,
        audioLiveNodeCount: audio ? audio.liveNodeCount : null,
        audioContextState: audio ? audio.contextState : null,
        fps,
        heapMB: heap,
        consoleErrorsCum: h.consoleErrors.length,
        consoleWarningsCum: h.consoleWarnings.length,
      };
      samples.push(sample);
      console.log(
        `[soak2] t=${sample.tSec}s seg=${sample.segment} speed=${sample.speedKmh?.toFixed?.(1)} lh=${lh} fb=${fb} audioNodes=${sample.audioLiveNodeCount} fps=${fps} heapMB=${heap?.toFixed?.(1)} errCum=${sample.consoleErrorsCum}`,
      );
    }
  } catch (err) {
    wasmDead = true;
    wasmError = String(err && err.message ? err.message : err);
    console.error('[soak2] EXCEPTION mid-session:', wasmError);
  }

  function slope(xs, ys) {
    const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => y !== null && y !== undefined && Number.isFinite(y));
    const n = pts.length;
    if (n < 3) return null;
    const mx = pts.reduce((s, [x]) => s + x, 0) / n;
    const my = pts.reduce((s, [, y]) => s + y, 0) / n;
    let num = 0, den = 0;
    for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    return den === 0 ? null : num / den;
  }
  const xs = samples.map((s) => s.tSec);
  const heapSlopePerSec = slope(xs, samples.map((s) => s.heapMB));
  const handleSlopePerSec = slope(xs, samples.map((s) => s.liveHandles));
  const audioSlopePerSec = slope(xs, samples.map((s) => s.audioLiveNodeCount));

  const findings = [];
  if (wasmDead) {
    const isKnownOob = /memory access out of bounds/i.test(wasmError || '');
    findings.push({ severity: 'blocker', issue: 'wasm trap / uncaught exception during long session', isKnownOob, wasmError, tSec: samples[samples.length - 1]?.tSec });
  }
  if (anyNaN) findings.push({ severity: 'blocker', issue: 'NaN/non-finite telemetry observed during long session' });
  if (heapSlopePerSec !== null && heapSlopePerSec > 0.05)
    findings.push({ severity: 'major', issue: 'JS heap grew with a clearly positive linear trend over the session', heapSlopePerSecMB: heapSlopePerSec, heapFirst: samples[0]?.heapMB, heapLast: samples[samples.length - 1]?.heapMB });
  if (handleSlopePerSec !== null && handleSlopePerSec > 0.01)
    findings.push({ severity: 'major', issue: 'liveHandleCount grew with a clearly positive linear trend over the session', handleSlopePerSec, handlesFirst: samples[0]?.liveHandles, handlesLast: samples[samples.length - 1]?.liveHandles });
  if (audioSlopePerSec !== null && audioSlopePerSec > 0.02)
    findings.push({ severity: 'major', issue: 'audio liveNodeCount grew with a clearly positive linear trend (leak) over the session', audioSlopePerSec, audioFirst: samples[0]?.audioLiveNodeCount, audioLast: samples[samples.length - 1]?.audioLiveNodeCount });
  const fpsVals = samples.map((s) => s.fps).filter((v) => v !== null);
  if (fpsVals.length >= 2) {
    const fpsFirst = fpsVals[0];
    const fpsLast = fpsVals[fpsVals.length - 1];
    if (fpsFirst > 0 && fpsLast < fpsFirst * 0.7) findings.push({ severity: 'major', issue: 'fps decayed >30% over the session', fpsFirst, fpsLast });
  }
  if (kickerLapsRun > 0) {
    findings.push({ severity: kickerStalls > 0 ? 'major' : 'polish', issue: `kicker-ramp stall observations during long session: ${kickerStalls}/${kickerLapsRun} kicker-laps segments ended stalled before the gate`, kickerStalls, kickerLapsRun });
  }

  const summary = {
    totalMsRequested: TOTAL_MS,
    actualDurationMs: Date.now() - t0,
    sampleCount: samples.length,
    wasmDead, wasmError, anyNaN,
    heapFirstMB: samples[0]?.heapMB ?? null,
    heapLastMB: samples[samples.length - 1]?.heapMB ?? null,
    heapSlopePerSecMB: heapSlopePerSec,
    handlesFirst: samples[0]?.liveHandles ?? null,
    handlesLast: samples[samples.length - 1]?.liveHandles ?? null,
    handleSlopePerSec,
    audioFirst: samples[0]?.audioLiveNodeCount ?? null,
    audioLast: samples[samples.length - 1]?.audioLiveNodeCount ?? null,
    audioSlopePerSec,
    fpsFirst: fpsVals[0] ?? null,
    fpsLast: fpsVals[fpsVals.length - 1] ?? null,
    kickerStallRate: kickerLapsRun > 0 ? `${kickerStalls}/${kickerLapsRun}` : 'n/a',
    totalConsoleErrors: h.consoleErrors.length,
    totalConsoleWarnings: h.consoleWarnings.length,
    totalPageErrors: h.pageErrors.length,
    findings,
  };
  writeJson('long-session-soak-samples.json', samples);
  writeJson('long-session-soak-summary.json', summary);
  console.log('[soak2] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[soak2] FATAL', err);
  process.exit(2);
});
