// SPDX-License-Identifier: MIT
//
// Reference-driven crash-realism measurement harness (crash-deformation-reference.md). Extends the
// damage harness with (a) a crush-depth probe -- the max chassis-local rearward (-Z) displacement of
// the front-shell deformable vertices, i.e. how far the nose caves in -- and (b) OFFSET (front-right)
// and SIDE crash setups that the frontal-only scenario.ts helpers don't cover, built directly on
// sim.world/sim.vehicle so no shared scenario.ts file is touched. Used by crash-realism.test.mjs and
// by verify/crash-realism/shoot-matrix.mjs's numeric cross-check.

import { DamageSim } from './damage-harness.mjs';
import { loadNative } from './harness.mjs';
import { FIXED_DT } from '../src/vehicle/tuning.ts';
import { rotateVector } from '../src/vehicle/mathUtil.ts';
import { BodyType } from '../../src/ts/index.ts';

const LOCAL_FORWARD = { x: 0, y: 0, z: 1 };
const LOCAL_RIGHT = { x: 1, y: 0, z: 0 };

export class CrashRealismSim extends DamageSim {
	/** Max chassis-local displacement of the front-shell proxy along -Z (nose cave-in depth, metres),
	 * plus the max total per-vertex displacement magnitude, over the 'chassis-front' mesh. */
	crushDepth() {
		const mesh = this.damage.registry.meshes.find((m) => m.id === 'chassis-front');
		if (!mesh) return { rearZ: 0, mag: 0, deep: 0 };
		let rearZ = 0;
		let mag = 0;
		let deep = 0; // vertices caved rearward past 10cm -- a discretisation-robust "how much crush" count
		for (let v = 0; v < mesh.vertexCount; v++) {
			const oz = mesh.offsets[v * 3 + 2];
			// -Z is rearward (into the car): a frontal impact caves nose vertices in -Z (post sign fix).
			if (-oz > rearZ) rearZ = -oz;
			if (-oz > 0.1) deep++;
			const m = Math.hypot(mesh.offsets[v * 3], mesh.offsets[v * 3 + 1], oz);
			if (m > mag) mag = m;
		}
		return { rearZ, mag, deep };
	}

	/** Half-width of the front-shell dent footprint on each side of centreline (metres), used to prove
	 * an OFFSET crash concentrates crush on the struck side rather than spreading it symmetrically. */
	dentLateralExtent() {
		const mesh = this.damage.registry.meshes.find((m) => m.id === 'chassis-front');
		if (!mesh) return { left: 0, right: 0 };
		let left = 0;
		let right = 0;
		for (let v = 0; v < mesh.vertexCount; v++) {
			const oz = mesh.offsets[v * 3 + 2];
			if (-oz < 0.02) continue; // only count genuinely dented vertices
			const bx = mesh.basePositions[v * 3];
			if (bx > 0 && bx > right) right = bx;
			if (bx < 0 && -bx > left) left = -bx;
		}
		return { left, right };
	}

	/** Spawn a rigid wall `distanceAhead` ahead of spawn, offset `lateralOffset` to the right and only
	 * `halfWidth` wide -- a moderate-overlap style barrier the car strikes with its front-right corner. */
	spawnOffsetWall(distanceAhead, lateralOffset, halfWidth) {
		const fwd = rotateVector(this.vehicle.spawnRotation, LOCAL_FORWARD);
		const right = rotateVector(this.vehicle.spawnRotation, LOCAL_RIGHT);
		const position = {
			x: this.vehicle.spawnPosition.x + fwd.x * distanceAhead + right.x * lateralOffset,
			y: 1.5,
			z: this.vehicle.spawnPosition.z + fwd.z * distanceAhead + right.z * lateralOffset,
		};
		const wall = this.world.createBody({ type: BodyType.Static, position });
		wall.createBoxShape({ halfExtents: { x: halfWidth, y: 2, z: 0.5 }, friction: 0.9, density: 1 });
		return wall;
	}

	/** Spawn a rigid wall to the RIGHT of the car (for a pure side impact), `distanceRight` metres out. */
	spawnSideWall(distanceRight) {
		const right = rotateVector(this.vehicle.spawnRotation, LOCAL_RIGHT);
		const position = {
			x: this.vehicle.spawnPosition.x + right.x * distanceRight,
			y: 1.5,
			z: this.vehicle.spawnPosition.z + right.z * distanceRight,
		};
		const wall = this.world.createBody({ type: BodyType.Static, position });
		// Long along the car's forward axis so the whole flank can strike it.
		wall.createBoxShape({ halfExtents: { x: 0.5, y: 2, z: 8 }, friction: 0.9, density: 1 });
		return wall;
	}

	/** Reset + launch the car straight forward at speedKmh (frontal), same as the base crash(). */
	crashFrontal(speedKmh) {
		this.crash(speedKmh);
	}

	/** Reset + launch the car sideways (+right) at speedKmh, for a pure side impact into spawnSideWall. */
	crashSideways(speedKmh) {
		this.crash(0); // resetVehicle + zero velocity
		const speedMs = speedKmh / 3.6;
		const right = rotateVector(this.vehicle.spawnRotation, LOCAL_RIGHT);
		const vel = { x: right.x * speedMs, y: 0, z: right.z * speedMs };
		this.vehicle.chassis.setLinearVelocity(vel);
		for (const w of Object.values(this.vehicle.wheels)) w.body.setLinearVelocity(vel);
		for (const p of Object.values(this.vehicle.panels)) p.body.setLinearVelocity(vel);
	}

	settle(steps) {
		for (let i = 0; i < steps; i++) this.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	}
}

export async function createCrashRealismSim(spawnPosition) {
	const native = await loadNative();
	return new CrashRealismSim(native, spawnPosition);
}

export const FRAMES_PER_SEC = Math.round(1 / FIXED_DT);
