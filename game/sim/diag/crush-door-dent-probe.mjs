// DIAGNOSTIC (crush M3, TEMP): side impact denting a DOOR inboard -- dent depth, door state, hull
// refreshes at a range of side speeds. Run: npx vite-node sim/diag/crush-door-dent-probe.mjs
import { createCrashRealismSim } from '../crash-realism-harness.mjs';

for (const speed of [20, 25, 30, 35, 40]) {
	const sim = await createCrashRealismSim();
	try {
		const wall = sim.spawnSideWall(3);
		sim.crashSideways(speed);
		sim.settle(300);
		const dt = sim.damageTelemetry();
		const mesh = sim.damage.registry.meshes.find((m) => m.kind === 'panel' && m.attachedTo === 'doorR');
		let maxOff = 0;
		const min = { x: Infinity, y: Infinity, z: Infinity };
		for (let v = 0; v < mesh.vertexCount; v++) {
			const off = Math.hypot(mesh.offsets[v * 3], mesh.offsets[v * 3 + 1], mesh.offsets[v * 3 + 2]);
			if (off > maxOff) maxOff = off;
			min.x = Math.min(min.x, mesh.basePositions[v * 3] + mesh.offsets[v * 3]);
		}
		console.log(
			`[door-dent] side ${speed}km/h doorR=${dt.panelStates.doorR} maxOff=${maxOff.toFixed(3)} aabbMinX=${min.x.toFixed(3)} refreshes=${JSON.stringify(sim.damage.panelHull.refreshes)}`,
		);
		void wall;
	} finally {
		sim.destroy();
	}
}
