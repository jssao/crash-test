// Denser diagnostic: sample debugReverse().grounded/deflection EVERY step of a straight-line
// throttle=1/steer=0 drive from spawn, to find exactly when/where a wheel first loses ground contact.
import { launchHarness } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4812, cdpPort: 9812, label: 'diag-gate2' });
  const { evalExpr } = h;
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");

  const run = await evalExpr(`(() => {
    const g = window.__GAME__;
    const events = [];
    let lastGrounded = { fl: true, fr: true, rl: true, rr: true };
    for (let i = 0; i < 700; i++) {
      g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      g.stepN(1);
      const t = g.telemetry;
      const dbg = g.debugReverse();
      const gr = dbg.grounded;
      for (const k of ['fl','fr','rl','rr']) {
        if (gr[k] !== lastGrounded[k]) {
          events.push({ i, wheel: k, groundedNow: gr[k], x: +t.chassisPos.x.toFixed(3), z: +t.chassisPos.z.toFixed(2), y: +t.chassisPos.y.toFixed(3), speed: +t.speedKmh.toFixed(1), defl: JSON.parse(JSON.stringify(dbg.deflection)) });
        }
      }
      lastGrounded = gr;
    }
    const t = g.telemetry;
    return { events, finalPos: t.chassisPos, finalSpeed: t.speedKmh };
  })()`);
  console.log('GROUND-STATE-CHANGE EVENTS:', JSON.stringify(run.events, null, 1));
  console.log('final:', JSON.stringify(run.finalPos), run.finalSpeed);
  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
