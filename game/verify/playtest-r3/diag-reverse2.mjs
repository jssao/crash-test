// Narrows the rear-wheel-detach-on-reverse finding: does it happen on a FRESH-SPAWN immediate
// reverse too, or only after a prior forward drive (torque-reversal spike hypothesis)?
import { launchHarness } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4818, cdpPort: 9818, label: 'diag-reverse2' });
  const { evalExpr } = h;

  async function wheelStates() { return (await evalExpr('window.__GAME__.telemetry')).damage.wheelStates; }

  console.log('--- Case A: fresh spawn, immediate reverse (brake=1) for 4s ---');
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  await evalExpr('window.__GAME__.stepN(20); "ok"');
  console.log('before:', JSON.stringify(await wheelStates()));
  await evalExpr(`(() => { const g=window.__GAME__; for (let i=0;i<240;i++){ g.setInput({throttle:0,brake:1,steer:0,handbrake:false}); g.stepN(1);} })(); 'ok'`);
  console.log('after 4s reverse from fresh spawn:', JSON.stringify(await wheelStates()));

  console.log('\n--- Case B: forward 3s -> brake-to-stop -> reverse 3s (repeat of diag-reverse.mjs) ---');
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  await evalExpr(`(() => { const g=window.__GAME__; for (let i=0;i<180;i++){ g.setInput({throttle:1,brake:0,steer:0,handbrake:false}); g.stepN(1);} })(); 'ok'`);
  console.log('after forward 3s:', JSON.stringify(await wheelStates()));
  await evalExpr(`(() => { const g=window.__GAME__; for (let i=0;i<240 && Math.abs(g.telemetry.speedKmh)>0.3;i++){ g.setInput({throttle:0,brake:1,steer:0,handbrake:false}); g.stepN(1);} })(); 'ok'`);
  console.log('after brake-to-stop:', JSON.stringify(await wheelStates()));
  await evalExpr(`(() => { const g=window.__GAME__; for (let i=0;i<180;i++){ g.setInput({throttle:0,brake:1,steer:0,handbrake:false}); g.stepN(1);} })(); 'ok'`);
  console.log('after 3s reverse:', JSON.stringify(await wheelStates()));

  console.log('\n--- Case C: forward 3s -> IMMEDIATE reverse (no stop phase, still moving forward) ---');
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  await evalExpr(`(() => { const g=window.__GAME__; for (let i=0;i<180;i++){ g.setInput({throttle:1,brake:0,steer:0,handbrake:false}); g.stepN(1);} })(); 'ok'`);
  console.log('after forward 3s:', JSON.stringify(await wheelStates()));
  await evalExpr(`(() => { const g=window.__GAME__; for (let i=0;i<240;i++){ g.setInput({throttle:0,brake:1,steer:0,handbrake:false}); g.stepN(1);} })(); 'ok'`);
  console.log('after 4s continuous brake/reverse (no separate stop phase):', JSON.stringify(await wheelStates()));

  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
