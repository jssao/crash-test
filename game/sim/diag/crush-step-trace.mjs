// DIAGNOSTIC (crush M2, TEMP): per-step yield trace for one frontal speed (SPEED env, default 80).
// Run: CRUSH_DEBUG=1 npx vite-node sim/diag/crush-step-trace.mjs
import { createCrashRealismSim } from '../crash-realism-harness.mjs';

const speed = process.env.SPEED ? +process.env.SPEED : 80;
const sim = await createCrashRealismSim();
sim.spawnWall(10);
sim.crashFrontal(speed);
sim.settle(120);
const t = sim.damageTelemetry().segments;
console.log(`[result] ${speed}km/h retreat=${t.coreRetreatM.front.toFixed(3)} crush=${t.frontCrushM.toFixed(3)} welds=${JSON.stringify(Object.fromEntries(Object.entries(t.weldCrushM).map(([k, v]) => [k, +v.toFixed(3)])))}`);
sim.destroy();
