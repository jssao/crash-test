// FINAL ENDURANCE PASS -- 10 continuous real-time minutes of scripted driving (same rAF-driven
// technique as playtest-soak/run2-long-session.mjs: persistent setInput() + the game's own live
// requestAnimationFrame loop, not stepN batching, so fps/heap/console trends are the ones a real
// session would produce), with periodic crush-heavy frontal impacts folded into the pattern mix (not
// just open driving) since this wave's objective is specifically about the crush-segment feature's
// endurance, and periodic resetCar()/resetWorld() so the segment-weld chain gets exercised repeatedly
// within the same live session (not just once at the very start).
//
// Usage: node verify/playtest-final/long-session.mjs
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from '../playtest-r3/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;
mkdirSync(OUT_DIR, { recursive: true });
function writeJson(name, obj) {
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
}

const PREVIEW_PORT = 4930;
const CDP_PORT = 9930;
const TOTAL_MS = 10 * 60_000; // 10 real minutes, per objective
const SEGMENT_MS = 30_000;
const SAMPLE_MS = 30_000;

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
const rng = mulberry32(0xc0de5);

const PATTERNS = ['slalom', 'perimeter-fast', 'crush-frontal', 'crush-offset', 'repair-car', 'repair-world'];

function allFinite(obj) {
  if (obj === null || obj === undefined) return true;
  if (typeof obj === 'number') return Number.isFinite(obj);
  if (typeof obj !== 'object') return true;
  for (const v of Object.values(obj)) if (!allFinite(v)) return false;
  return true;
}

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'playtest-final-long' });
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
  const t0 = Date.now();
  let nextSegmentAt = 0;

  try {
    while (Date.now() - t0 < TOTAL_MS) {
      const elapsed = Date.now() - t0;
      if (elapsed >= nextSegmentAt) {
        const pattern = PATTERNS[Math.floor(rng() * PATTERNS.length)];
        lastSegment = pattern;
        console.log(`[long-session] t=${Math.round(elapsed / 1000)}s segment=${pattern}`);
        if (pattern === 'repair-car') {
          await evalExpr("window.__GAME__.resetCar(); window.__GAME__.setInput({ throttle: 0.6, brake: 0, steer: 0, handbrake: false }); 'ok'");
        } else if (pattern === 'repair-world') {
          await evalExpr("window.__GAME__.resetWorld(); window.__GAME__.setInput({ throttle: 0.6, brake: 0, steer: 0, handbrake: false }); 'ok'");
        } else if (pattern === 'slalom') {
          const steer = (rng() - 0.5) * 1.2;
          await evalExpr(`window.__GAME__.setInput({ throttle: 0.55, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        } else if (pattern === 'perimeter-fast') {
          const steer = (rng() - 0.5) * 0.5;
          await evalExpr(`window.__GAME__.setInput({ throttle: 1, brake: 0, steer: ${steer.toFixed(2)}, handbrake: false }); 'ok'`);
        } else if (pattern === 'crush-frontal') {
          await evalExpr("window.__GAME__.spawnTestWall(20); window.__GAME__.crash(64); 'ok'");
        } else {
          // crush-offset
          await evalExpr("window.__GAME__.spawnTestWall(20); window.__GAME__.crash(60); window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0.2, handbrake: false }); 'ok'");
        }
        nextSegmentAt = elapsed + SEGMENT_MS;
      }

      const waitMs = Math.min(SAMPLE_MS, TOTAL_MS - (Date.now() - t0));
      if (waitMs > 0) await sleep(waitMs);

      const t = await evalExpr('window.__GAME__.telemetry').catch((e) => { throw e; });
      const lh = await evalExpr('window.__GAME__.liveHandleCount()');
      const fb = await evalExpr('window.__GAME__.featureBodyCount()');
      const fps = await fpsNum();
      const heap = await heapMB();
      const finite = allFinite(t);
      if (!finite) anyNaN = true;
      const sample = {
        tSec: Math.round((Date.now() - t0) / 1000), segment: lastSegment, speedKmh: t.speedKmh, chassisPos: t.chassisPos,
        finite, liveHandles: lh, featureBodies: fb, fps, heapMB: heap,
        frontCrushM: t.damage?.segments?.frontCrushM ?? null, intrusionM: t.damage?.segments?.intrusionM ?? null,
        consoleErrorsCum: h.consoleErrors.length, consoleWarningsCum: h.consoleWarnings.length,
      };
      samples.push(sample);
      console.log(`[long-session] t=${sample.tSec}s seg=${sample.segment} speed=${sample.speedKmh?.toFixed?.(1)} lh=${lh} fb=${fb} fps=${fps} heapMB=${heap?.toFixed?.(1)} frontCrush=${sample.frontCrushM?.toFixed?.(3)} errCum=${sample.consoleErrorsCum}`);
    }
  } catch (err) {
    wasmDead = true;
    wasmError = String(err && err.message ? err.message : err);
    console.error('[long-session] EXCEPTION mid-session:', wasmError);
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

  const findings = [];
  if (wasmDead) {
    const isKnownOob = /memory access out of bounds/i.test(wasmError || '');
    findings.push({ severity: 'blocker', issue: 'wasm trap / uncaught exception during 10-min long session', isKnownOob, wasmError, tSec: samples[samples.length - 1]?.tSec });
  }
  if (anyNaN) findings.push({ severity: 'blocker', issue: 'NaN/non-finite telemetry observed during 10-min long session' });
  if (heapSlopePerSec !== null && heapSlopePerSec > 0.05)
    findings.push({ severity: 'major', issue: 'JS heap grew with a clearly positive linear trend over 10 minutes', heapSlopePerSecMB: heapSlopePerSec, heapFirst: samples[0]?.heapMB, heapLast: samples[samples.length - 1]?.heapMB });
  if (handleSlopePerSec !== null && handleSlopePerSec > 0.01)
    findings.push({ severity: 'major', issue: 'liveHandleCount grew with a clearly positive linear trend over 10 minutes', handleSlopePerSec, handlesFirst: samples[0]?.liveHandles, handlesLast: samples[samples.length - 1]?.liveHandles });
  const fpsVals = samples.map((s) => s.fps).filter((v) => v !== null);
  if (fpsVals.length >= 2) {
    const fpsFirst = fpsVals[0];
    const fpsLast = fpsVals[fpsVals.length - 1];
    if (fpsFirst > 0 && fpsLast < fpsFirst * 0.7) findings.push({ severity: 'major', issue: 'fps decayed >30% over the 10-min session', fpsFirst, fpsLast });
  }

  const summary = {
    totalMsRequested: TOTAL_MS, actualDurationMs: Date.now() - t0, sampleCount: samples.length, wasmDead, wasmError, anyNaN,
    heapFirstMB: samples[0]?.heapMB ?? null, heapLastMB: samples[samples.length - 1]?.heapMB ?? null, heapSlopePerSecMB: heapSlopePerSec,
    handlesFirst: samples[0]?.liveHandles ?? null, handlesLast: samples[samples.length - 1]?.liveHandles ?? null, handleSlopePerSec,
    fpsFirst: fpsVals[0] ?? null, fpsLast: fpsVals[fpsVals.length - 1] ?? null,
    totalConsoleErrors: h.consoleErrors.length, totalConsoleWarnings: h.consoleWarnings.length, totalPageErrors: h.pageErrors.length, findings,
  };
  writeJson('long-session-samples.json', samples);
  writeJson('long-session-summary.json', summary);
  console.log('[long-session] SUMMARY', JSON.stringify(summary, null, 2));

  await h.close();
  process.exit(findings.some((f) => f.severity === 'blocker') ? 1 : 0);
}

main().catch((err) => {
  console.error('[long-session] FATAL', err);
  process.exit(2);
});
