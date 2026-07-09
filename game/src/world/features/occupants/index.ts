// SPDX-License-Identifier: MIT
//
// 'occupants' WorldFeature: 4 articulated ragdoll passengers seated in the car (11 capsule bodies +
// 11 joints each, see ./physics.ts's module doc for the full kinematic-chain/collision-filtering/
// lifecycle design), rendered via ./visuals.ts, orchestrated here per the WorldFeature contract
// (../feature.ts). Self-contained: builds its own minimal seat-pan bodies (no dependency on a
// 'cardetail' feature), per the task's explicit ownership split.

import * as THREE from 'three';
import type { FeatureContext, WorldFeature } from '../feature';
import {
	createOccupant,
	createSeatPan,
	matchOccupantVelocity,
	matchSeatPanVelocity,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
	type Occupant,
	type SeatPan,
} from './physics';
import { SEAT_KEYS, type SeatKey } from './tuning';
import { applyOccupantVisual, buildOccupantVisual, disposeOccupantVisual, sampleOccupantVisual, type OccupantVisual } from './visuals';

interface OccupantEntry {
	seatKey: SeatKey;
	occupant: Occupant;
	visual: OccupantVisual;
}

export default function createOccupantsFeature(ctx: FeatureContext): WorldFeature {
	const seatPans: SeatPan[] = [];
	const entries: OccupantEntry[] = [];

	/**
	 * Builds all 4 seat pans + all 4 occupants fresh against the CURRENT vehicle (never cached across
	 * a reset -- feature.ts's contract note #2). Used both at factory-time and on every reset('car'|
	 * 'world') -- see ./physics.ts's CHASSIS-ATTACHED-JOINT LIFECYCLE HAZARD doc comment for why a
	 * reset always tears down + recreates rather than repositioning in place (the chassis a prior
	 * reset's occupants were welded to is, by the time reset() fires, already destroyed).
	 */
	function seatAll(): void {
		const vehicle = ctx.getVehicle();
		const chassis = vehicle.chassis;
		const t = chassis.getTransform();

		SEAT_KEYS.forEach((seatKey, seatIndex) => {
			seatPans.push(createSeatPan(ctx.world, chassis, seatKey, t.position, t.rotation));
			const occupant = createOccupant(ctx.world, chassis, seatIndex, seatKey, t.position, t.rotation);
			const visual = buildOccupantVisual(occupant, seatKey);
			ctx.scene.add(visual.group);
			entries.push({ seatKey, occupant, visual });
		});
	}

	function teardownAll(): void {
		for (const entry of entries) {
			ctx.scene.remove(entry.visual.group);
			disposeOccupantVisual(entry.visual);
			teardownOccupant(entry.occupant);
		}
		entries.length = 0;
		for (const pan of seatPans) teardownSeatPan(pan);
		seatPans.length = 0;
	}

	seatAll();

	return {
		name: 'occupants',

		afterFixedStep(): void {
			for (const entry of entries) {
				pollOccupantRestraint(entry.occupant);
				sampleOccupantVisual(entry.occupant, entry.visual);
			}
		},

		applyVisuals(alpha: number): void {
			for (const entry of entries) applyOccupantVisual(entry.visual, alpha);
		},

		reset(): void {
			// Same rebuild for BOTH 'car' and 'world': main.ts's doWorldRepair() always runs a full
			// doCarRepair() (destroy+recreate chassis) before either reset() fires, so by the time this
			// runs there is never a "car unchanged" case to special-case -- see ./physics.ts's doc
			// comment.
			teardownAll();
			seatAll();
		},

		bodyCount(): number {
			return entries.length * 11 + seatPans.length;
		},

		hooks: {
			/** Read-only per-seat state for scripted playtests (game/verify/feature-occupants.mjs,
			 * game/sim/features-occupants.test.mjs). */
			seatStates: () =>
				entries.map((e) => ({
					seatKey: e.seatKey,
					ejected: e.occupant.ejected,
					restraintForceN: e.occupant.restraintJoint ? vecLength(e.occupant.restraintJoint.getConstraintForce()) : null,
					pelvisPos: e.occupant.parts.pelvis.body.getPosition(),
				})),
			/** Diagnostic-only: per-seat torso mesh world position/visibility, for verify-script sanity
			 * checks when a render-side screenshot doesn't show what's expected. */
			debugVisuals: () =>
				entries.map((e) => {
					const mesh = e.visual.parts.torso.mesh;
					const p = new THREE.Vector3();
					mesh.getWorldPosition(p);
					return {
						seatKey: e.seatKey,
						groupVisible: e.visual.group.visible,
						meshVisible: mesh.visible,
						worldPos: { x: p.x, y: p.y, z: p.z },
						inScene: mesh.parent !== null,
					};
				}),
			/** Sets every seated occupant's velocity to the chassis's CURRENT velocity -- lets a crash
			 * scenario (window.__GAME__.crash()) start each occupant "already riding along" instead of
			 * an artificial t=0 relative-velocity spike (see physics.ts's matchOccupantVelocity() doc). */
			matchVehicleVelocity: () => {
				const v = ctx.getVehicle().chassis.getLinearVelocity();
				for (const entry of entries) if (!entry.occupant.ejected) matchOccupantVelocity(entry.occupant, v);
				for (const pan of seatPans) matchSeatPanVelocity(pan, v);
			},
		},

		dispose(): void {
			teardownAll();
		},
	};
}

function vecLength(v: { x: number; y: number; z: number }): number {
	return Math.hypot(v.x, v.y, v.z);
}
