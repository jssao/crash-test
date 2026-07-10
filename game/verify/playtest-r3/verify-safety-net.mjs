// Verifies the world-containment safety-net's SECOND layer: main.ts's kill-plane (chassis y < -10 ->
// automatic resetCar() + HUD toast). Layer 1 (the terrain's containment berm, world/terrain/
// heightfield.ts's bermRise()) makes an actual world-edge escape essentially unreachable in normal
// play now (see diag-topspeed.mjs, which used to measure 668km/h at y=-3969 and now shows the car
// contained near the +-400m edge) -- so this script uses the debugForceFreefall() diagnostic hook
// (main.ts's window.__GAME__, test-only) to directly exercise the kill-plane's own trigger/recovery/
// toast wiring without needing to first reproduce a real escape.
//
// Usage: node verify/playtest-r3/verify-safety-net.mjs
import { launchHarness, sleep } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4834, cdpPort: 9834, label: 'verify-safety-net' });
  const { evalExpr } = h;

  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const before = await evalExpr('window.__GAME__.telemetry.chassisPos');
  console.log('spawn pose:', JSON.stringify(before));

  await evalExpr('window.__GAME__.debugForceFreefall(); "ok"');
  const midFlight = await evalExpr('window.__GAME__.telemetry.chassisPos');
  console.log('forced into freefall (pre-recovery):', JSON.stringify(midFlight));
  if (midFlight.y > -10) throw new Error(`expected the forced pose to be below the kill-plane (y<-10), got y=${midFlight.y}`);

  // One fixed step is enough for main.ts's doFixedStep() kill-plane check to fire.
  const afterOneStep = await evalExpr(`(() => {
    const g = window.__GAME__;
    g.stepN(1);
    return { pos: g.telemetry.chassisPos, awake: g.chassisAwake() };
  })()`);
  console.log('after 1 fixed step (should already be back at spawn):', JSON.stringify(afterOneStep));

  const recoveredAtSpawn =
    Math.abs(afterOneStep.pos.x - before.x) < 0.01 &&
    Math.abs(afterOneStep.pos.y - before.y) < 0.05 &&
    Math.abs(afterOneStep.pos.z - before.z) < 0.01;

  const toastState = await evalExpr(`(() => {
    const el = document.getElementById('hud-toast');
    return { text: el && el.textContent, visible: el && el.classList.contains('hud-toast-visible') };
  })()`);
  console.log('HUD toast state:', JSON.stringify(toastState));

  await sleep(300);
  await h.screenshot('verify-safety-net-toast');

  const ok = recoveredAtSpawn && toastState.visible === true && toastState.text === 'recovered';
  console.log(ok ? 'PASS: kill-plane recovered to spawn pose + showed the "recovered" toast' : 'FAIL: see details above');
  await h.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
