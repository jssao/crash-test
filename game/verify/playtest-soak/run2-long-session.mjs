// ENDURANCE SOAK run 2: LONG CONTINUOUS SESSION -- >=12 REAL minutes of uninterrupted scripted
// driving (slalom west toward the tree line, buildings east, kicker jumps, high-speed perimeter
// laps), occasional 'R' car-repair (resetCar(), NOT resetWorld()) but no world reset. Drives via
// persistent setInput() + the game's own live requestAnimationFrame loop (real wall-clock time, same
// as verify/playtest-soak/run3's rim-drive technique) rather than window.__GAME__.stepN() batching,
// so fps/heap/console trends are observed the same way a real play session would produce them.
// Reuses verify/playtest/lib.mjs's harness (read-only import).
//
// Usage: node verify/playtest-soak/run2-long-session.mjs
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchHarness, sleep, allFinite, gameRoot } from '../playtest/lib.mjs';

const OUT_DIR = path.join(gameRoot, 'verify', 'playtest-soak');
mkdirSync(OUT_DIR, { recursive: true });
function writeJson(name, obj) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
}

const TOTAL_MS = 12.5 * 60_000; // 12.5 real minutes (>=12 min requested, small buffer)
const SEGMENT_MS = 30_000; // change driving pattern every 30s
const SAMPLE_MS = 30_000; // sample every 30s

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
const rng = mulberry32(0x1e55);

// Segment patterns: each sets a persistent input state (occasionally re-aimed). 'repair' triggers
// resetCar() (NOT resetWorld()) mid-session, per the spec ("occasional R car-repair but NO world
// reset").
const PATTERNS = ['slalom-west', 'buildings-east', 'kicker-laps', 'perimeter-fast', 'repair'];

async function main() {
  const h = await launchHarness({ previewPort: 4730, cdpPort: 9730, label: 'soak-run2' });
  const evalExpr = h.evalExpr;

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
  const t0 = Date.now();
  let nextSegmentAt = 0;
  let nextSampleAt = 0;

  try {
    while (Date.now() - t0 < TOTAL_MS) {
      const elapsed = Date.now() - t0;
      if (elapsed >= nextSegmentAt) {
        const pattern = PATTERNS[Math.floor(rng() * PATTERNS.length)];
        lastSegment = pattern;
        console.log(`[run2] t=${Math.round(elapsed / 1000)}s segment=${pattern}`);
        if (pattern === 'repair') {
          await evalExpr("window.__GAME__.resetCar(); 'ok'");
          await evalExpr("window.__GAME__.setInput({ throttle: 0.6, brake: 0, steer: 0, handbrake: false }); 'ok'");
        } else if (pattern === 'slalom-west') {
          const steer = (rng() - 0.5) * 1.4;
          await evalExpr(`window.__GAME__.setInput({ throttle: 0.55, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        } else if (pattern === 'buildings-east') {
          const steer = 0.15 + rng() * 0.15;
          await evalExpr(`window.__GAME__.setInput({ throttle: 0.7, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        } else if (pattern === 'kicker-laps') {
          await evalExpr("window.__GAME__.setInput({ throttle: 0.85, brake: 0, steer: 0, handbrake: false }); 'ok'");
        } else {
          // perimeter-fast: wide sweeping turn
          const steer = (rng() - 0.5) * 0.6;
          await evalExpr(`window.__GAME__.setInput({ throttle: 1, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        }
        nextSegmentAt = elapsed + SEGMENT_MS;
      }

      const waitMs = Math.min(SAMPLE_MS, TOTAL_MS - (Date.now() - t0));
      if (waitMs > 0) await sleep(waitMs);

      const t = await evalExpr('window.__GAME__.telemetry');
      const lh = await evalExpr('window.__GAME__.liveHandleCount()');
      const fb = await evalExpr('window.__GAME__.featureBodyCount()');
      const fps = await fpsNum();
      const heap = await heapMB();
      const finite = allFinite(t);
      if (!finite) anyNaN = true;
      const sample = {
        tSec: Math.round((Date.now() - t0) / 1000),
        segment: lastSegment,
        speedKmh: t.speedKmh,
        chassisPos: t.chassisPos,
        finite,
        liveHandles: lh,
        featureBodies: fb,
        fps,
        heapMB: heap,
        consoleErrorsCum: h.consoleErrors.length,
        consoleWarningsCum: h.consoleWarnings.length,
      };
      samples.push(sample);
      console.log(
        `[run2] t=${sample.tSec}s seg=${sample.segment} speed=${sample.speedKmh?.toFixed?.(1)} lh=${lh} fb=${fb} fps=${fps} heapMB=${heap?.toFixed?.(1)} errCum=${sample.consoleErrorsCum}`,
      );
    }
  } catch (err) {
    wasmDead = true;
    wasmError = String(err && err.message ? err.message : err);
    console.error('[run2] EXCEPTION mid-session:', wasmError);
  }

  // Linear regression (least squares) of heap (MB) and liveHandles vs tSec, to flag a clearly positive
  // growth trend rather than eyeballing noisy samples.
  function slope(xs, ys) {
    const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => y !== null && y !== undefined && Number.isFinite(y));
    const n = pts.length;
    if (n < 3) return null;
    const mx = pts.reduce((s, [x]) => s + x, 0) / n;
    const my = pts.reduce((s, [, y]) => s + y, 0) / n;
    let num = 0,
      den = 0;
    for (const [x, y] of pts) {
      num += (x - mx) * (y - my);
      den += (x - mx) ** 2;
    }
    return den === 0 ? null : num / den;
  }
  const xs = samples.map((s) => s.tSec);
  const heapSlopePerSec = slope(xs, samples.map((s) => s.heapMB));
  const handleSlopePerSec = slope(xs, samples.map((s) => s.liveHandles));

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
  const fpsVals = samples.map((s) => s.fps).filter((v) => v !== null);
  if (fpsVals.length >= 2) {
    const fpsFirst = fpsVals[0];
    const fpsLast = fpsVals[fpsVals.length - 1];
    if (fpsFirst > 0 && fpsLast < fpsFirst * 0.7) findings.push({ severity: 'major', issue: 'fps decayed >30% over the session', fpsFirst, fpsLast });
  }

  const summary = {
    totalMsRequested: TOTAL_MS,
    actualDurationMs: Date.now() - t0,
    sampleCount: samples.length,
    wasmDead,
    wasmError,
    anyNaN,
    heapFirstMB: samples[0]?.heapMB ?? null,
    heapLastMB: samples[samples.length - 1]?.heapMB ?? null,
    heapSlopePerSecMB: heapSlopePerSec,
    handlesFirst: samples[0]?.liveHandles ?? null,
    handlesLast: samples[samples.length - 1]?.liveHandles ?? null,
    handleSlopePerSec,
    fpsFirst: fpsVals[0] ?? null,
    fpsLast: fpsVals[fpsVals.length - 1] ?? null,
    totalConsoleErrors: h.consoleErrors.length,
    totalConsoleWarnings: h.consoleWarnings.length,
    totalPageErrors: h.pageErrors.length,
    findings,
  };
  writeJson('run2-long-session-samples.json', samples);
  writeJson('run2-long-session-summary.json', summary);
  console.log('[run2] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[run2] FATAL', err);
  process.exit(2);
});
