// DIAGNOSTIC (crush M2, TEMP): measures the MECHANICAL crush/intrusion matrix (segment telemetry)
// at 40/56/64/80/120 frontal + 64 offset, for calibrating sim/segment-yield.test.mjs's assertions.
// Run: npx vite-node sim/diag/crush-yield-measure.mjs
import { createCrashRealismSim } from '../crash-realism-harness.mjs';

for (const speed of [40, 56, 64, 80, 120]) {
	const sim = await createCrashRealismSim();
	try {
		sim.spawnWall(10);
		sim.crashFrontal(speed);
		sim.settle(300);
		const t1 = sim.damageTelemetry().segments;
		sim.settle(60);
		const t2 = sim.damageTelemetry().segments;
		const cosmetic = sim.crushDepth().rearZ;
		console.log(
			`[yield] FRONTAL ${speed}km/h mechCrush=${t1.frontCrushM.toFixed(3)} (stable +60: ${t2.frontCrushM.toFixed(3)}) rear=${t1.rearCrushM.toFixed(3)} intrusion=${t1.intrusionM.toFixed(3)} coreRetreat=${t1.coreRetreatM.front.toFixed(3)} cosmetic=${cosmetic.toFixed(3)} torn=${JSON.stringify(t1.tornWelds)} welds=${JSON.stringify(Object.fromEntries(Object.entries(t1.weldCrushM).map(([k, v]) => [k, +v.toFixed(3)])))}`,
		);
	} finally {
		sim.destroy();
	}
}

// 64km/h moderate-overlap style offset (struck side = RIGHT): struck-side rail cells must carry the
// crush, intact side much less.
{
	const sim = await createCrashRealismSim();
	try {
		// PROPER IIHS-style 40% moderate overlap: barrier covers x 0.19..1.01 (40% of the ~1.94m car
		// width from the +x edge) -- it must NOT cross the centerline (the first probe's -0.13..1.37
		// wall genuinely clipped the -x half-core, symmetrizing the "offset" crash).
		sim.spawnOffsetWall(10, 0.6, 0.41);
		sim.crashFrontal(64);
		sim.settle(300);
		const t = sim.damageTelemetry().segments;
		console.log(
			`[yield] OFFSET-POS 64km/h mechCrush=${t.frontCrushM.toFixed(3)} intrusion=${t.intrusionM.toFixed(3)} coreRetreat pos=${t.coreRetreatFrontM.pos.toFixed(3)} neg=${t.coreRetreatFrontM.neg.toFixed(3)} welds=${JSON.stringify(Object.fromEntries(Object.entries(t.weldCrushM).map(([k, v]) => [k, +v.toFixed(3)])))} torn=${JSON.stringify(t.tornWelds)}`,
		);
	} finally {
		sim.destroy();
	}
}

// Reset heals plastic state (in-place resetVehicle path).
{
	const sim = await createCrashRealismSim();
	try {
		sim.spawnWall(10);
		sim.crashFrontal(80);
		sim.settle(300);
		const before = sim.damageTelemetry().segments;
		sim.crashFrontal(0); // crash() -> crashSetup -> resetVehicle + zero speed
		sim.settle(60);
		const after = sim.damageTelemetry().segments;
		console.log(`[yield] RESET: before=${before.frontCrushM.toFixed(3)} after=${after.frontCrushM.toFixed(3)} weldsAfter=${JSON.stringify(Object.fromEntries(Object.entries(after.weldCrushM).map(([k, v]) => [k, +v.toFixed(3)])))}`);
	} finally {
		sim.destroy();
	}
}
