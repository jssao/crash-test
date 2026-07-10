import { launchHarness, DRIVE_TOWARD_SNIPPET } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4817, cdpPort: 9817, label: 'diag-reverse' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const d1 = await evalExpr('window.__driveToward(0, 20, 300, 3, 0.6, 0.8, 40, 20)');
  console.log('drive-in:', JSON.stringify({ steps: d1.steps, finalPos: d1.finalPos, speedKmh: d1.speedKmh }));
  console.log('wheelStates after drive-in:', JSON.stringify((await evalExpr('window.__GAME__.telemetry')).damage.wheelStates));

  const stopTrace = await evalExpr(`(() => {
    const g = window.__GAME__;
    const trace = [];
    for (let i = 0; i < 240; i++) {
      g.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false });
      g.stepN(1);
      const t = g.telemetry;
      if (i % 10 === 0) trace.push({ i, z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(2) });
      if (Math.abs(t.speedKmh) < 0.3) { trace.push({ i, z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(2), stoppedAt: i }); break; }
    }
    return trace;
  })()`);
  console.log('stop-trace:', JSON.stringify(stopTrace));
  console.log('wheelStates after stop:', JSON.stringify((await evalExpr('window.__GAME__.telemetry')).damage.wheelStates));

  const revTrace = await evalExpr(`(() => {
    const g = window.__GAME__;
    const trace = [];
    const t0 = g.telemetry;
    for (let i = 0; i < 180; i++) {
      g.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false });
      g.stepN(1);
      if (i % 15 === 0) { const t = g.telemetry; trace.push({ i, z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(2) }); }
    }
    return { start: t0.chassisPos, trace };
  })()`);
  console.log('reverse-trace:', JSON.stringify(revTrace));
  console.log('wheelStates after reverse:', JSON.stringify((await evalExpr('window.__GAME__.telemetry')).damage.wheelStates));

  const fwdTrace = await evalExpr(`(() => {
    const g = window.__GAME__;
    const trace = [];
    for (let i = 0; i < 120; i++) {
      g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      g.stepN(1);
      if (i % 10 === 0) { const t = g.telemetry; const dbg = g.debugReverse(); trace.push({ i, z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(2), wRL: +t.wheelOmegas.rl.toFixed(1), wRR: +t.wheelOmegas.rr.toFixed(1), wFL: +t.wheelOmegas.fl.toFixed(1), wFR: +t.wheelOmegas.fr.toFixed(1), wheelStates: t.damage.wheelStates, groundedRL: dbg.grounded.rl, groundedRR: dbg.grounded.rr, dbgRL: dbg.rearOmegaRL, dbgRR: dbg.rearOmegaRR }); }
    }
    return trace;
  })()`);
  console.log('forward-resume-trace:', JSON.stringify(fwdTrace));

  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
