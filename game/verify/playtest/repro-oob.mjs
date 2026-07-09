// Focused repro attempt for the wasm "memory access out of bounds" trap first seen during battery.mjs's
// free-drive scenario (steerAmp 0.5 figure-eight at ~50km/h, 1800 steps). Fresh browser session, same
// drive params, no preceding calibration -- isolates whether free-drive ALONE is sufficient to trigger it.
import { launchHarness, drive, pingHealthy, pingStepAlive, writeJson } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4181, cdpPort: 9431, width: 1280, height: 720, label: 'repro-oob' });
  const { evalExpr } = h;
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const res = await drive(evalExpr, { mode: 'figure8', period: 80, steerAmp: 0.5, targetSpeed: 50, maxSteps: 1800, sampleEvery: 5, sampleDamage: true, sampleWheels: true });
  console.log('error:', JSON.stringify(res.error, null, 2));
  console.log('samples collected:', res.samples.length);
  console.log('last 5 samples:', JSON.stringify(res.samples.slice(-5), null, 2));
  await new Promise((r) => setTimeout(r, 1000)); // let the now-permanently-erroring rAF loop paint a frame
  await h.screenshot('00-wasm-oob-repro-stuck-car');
  const health = await pingHealthy(evalExpr);
  console.log('post-crash telemetry read:', health.readable, health.readable ? '' : health.error);
  const stepAlive = await pingStepAlive(evalExpr);
  console.log('post-crash stepN(1):', stepAlive.stepOk, stepAlive.stepOk ? '' : stepAlive.error);
  const stepAlive2 = await pingStepAlive(evalExpr);
  console.log('post-crash stepN(1) again:', stepAlive2.stepOk, stepAlive2.stepOk ? '' : stepAlive2.error);
  writeJson('repro-oob-result.json', { error: res.error, samples: res.samples, health, stepAlive, stepAlive2 });
  await h.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[repro-oob] FATAL', err);
  process.exit(1);
});
