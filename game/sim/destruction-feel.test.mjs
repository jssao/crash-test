// SPDX-License-Identifier: MIT
//
// DESTRUCTION-FEEL regression test (design-judgment slot: "make destruction feel PHYSICAL instead of
// hard bodies getting blasted"). Asserts the plastic-yield (bend-then-break) model + impulse-
// proportional / material-tuned debris the buildings & trees features now implement, via a staged
// low(30)/mid(70)/high(120 km/h) impact matrix per structure. Imports the renderer-free physics
// modules DIRECTLY (skips the WorldFeature registry, per registry.ts's doc comment), same pattern as
// game/sim/features-buildings.test.mjs.
//
// METHODOLOGY: every impact COASTS (throttle 0) after an instantaneous launch so what's measured is
// the IMPACT's own signature, not several seconds of the car plowing debris ahead of it (which is
// chaotic at high energy). Under coasting the runs are bit-deterministic; assertions still use margins
// and mostly RELATIVE (high-vs-low) comparisons so they stay robust to WASM-allocator state carried
// between the many worlds a full suite run creates.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import {
	buildBrickWall,
	buildFenceLine,
	buildHouseCorner,
	buildShed,
	pollStructureBreaks,
	resetStructure,
	totalYieldedJointCount,
} from '../src/world/features/buildings/structures.ts';
import { BRICK_WALL_CENTER, CORNER_POINT, CORNER_SEGMENT_LENGTH_M, FENCE_CONFIGS, SHED_CENTER } from '../src/world/features/buildings/tuning.ts';
import { createTreesWorld, stepTreesWorld, trunkTiltDeg } from '../src/world/features/trees/bodies.ts';
import { MID_SITES } from '../src/world/features/trees/tuning.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}
async function makeWorld() {
	const native = await loadNative();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	return world;
}
function launch(vehicle, speedKmh) {
	const s = speedKmh / 3.6;
	const v = { x: 0, y: 0, z: s };
	vehicle.chassis.setLinearVelocity(v);
	for (const w of Object.values(vehicle.wheels)) w.body.setLinearVelocity(v);
	for (const p of Object.values(vehicle.panels)) p.body.setLinearVelocity(v);
}
const COAST = { throttle: 0, brake: 0, steer: 0, handbrake: false };

// The 120km/h brick-wall runs need a REAL run-up, not just a bigger instantaneous velocity. At the
// standard 16m approach (BRICK_WALL_CENTER.z=24, approachZ=8) a 120km/h launch only gets ~25 physics
// steps of travel before impact -- too few for the freshly-spawned chassis/wheels/panels (still
// carrying spawn-transient contact state from the instantaneous launch()) to settle into a normal
// rolling contact posture. That lands the wall hit mid-transient, and the single-frame collision
// response it produces is measurably WEAKER than the 70km/h hit's (peak debris 15.96 m/s < 70's
// 19.8), inverting the intended energy ordering. Measured fix (game/verify/asymmetric-launch-style
// real run-up, sim/_measure-tmp.test.mjs scratch harness): tripling the approach distance to 36m
// gives the 120km/h launch ~64 steps of ordinary travel to settle before impact, which restores
// strictly-rising peak debris (30->5.7, 70->16.8, 120->26.3 m/s) with comfortable margin over every
// band below. 30/70 already have ample run-up/settle time at the standard distance (115/44 steps to
// impact) and are untouched.
const HIGH_SPEED_APPROACH_Z = -12;

/** Drive a coasting impact into `structure` and return its debris/deformation signature. `kind` filters
 * the measured pieces to one material (e.g. 'brick'); null measures every dynamic piece. */
async function impactSignature(build, centerX, approachZ, kind, speedKmh, steps = 200) {
	const world = await makeWorld();
	try {
		const structure = build(world);
		const vehicle = createVehicle(world, { x: centerX, y: 0.5, z: approachZ });
		launch(vehicle, speedKmh);
		let peakDebrisSpeed = 0;
		let peakDebrisSum = 0;
		const pieces = structure.pieces.filter((p) => !p.isStatic && (!kind || p.kind === kind));
		for (let i = 0; i < steps; i++) {
			stepVehicle(vehicle, COAST, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
			pollStructureBreaks(structure);
			if (i > 10 && i < 130) {
				let sum = 0;
				for (const p of pieces) {
					const v = p.body.getLinearVelocity();
					const s = Math.hypot(v.x, v.y, v.z);
					peakDebrisSpeed = Math.max(peakDebrisSpeed, s);
					sum += s;
				}
				peakDebrisSum = Math.max(peakDebrisSum, sum);
			}
		}
		const disps = pieces.map((p) => {
			const pos = p.body.getPosition();
			return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z);
		});
		const moved03 = disps.filter((d) => d > 0.3).length;
		const meanDisp = disps.reduce((a, b) => a + b, 0) / Math.max(1, disps.length);
		const brokenJoints = structure.joints.filter((j) => j.broken).length;
		const bentJoints = structure.joints.filter((j) => !j.broken && j.stage === 'yielded').length;
		return { structure, brokenJoints, bentJoints, moved03, meanDisp, peakDebrisSpeed, peakDebrisSum, total: pieces.length };
	} finally {
		world.destroy();
	}
}

describe('destruction-feel: buildings bend-then-break + staged debris', () => {
	it('brick wall: a 30km/h nudge CRACKS in clumps (no jelly wobble); a 120km/h hit SHATTERS -- measurably distinct', async () => {
		// RECALIBRATED for the crisp break-only masonry model (playtest issue #3). The old model
		// plastically YIELDED the mortar lattice so the whole wall wobbled as a soft blob (the user's
		// exact complaint: "stuck together in a weird way ... moves as one wobbly blob"). Masonry welds
		// are now break-ONLY: rigid until they crack. So a brick wall NEVER bends -- bentJoints is 0 at
		// every speed. The low/high distinction is carried by HOW MANY mortar joints crack (and how fast
		// debris flies), and low-speed damage tumbles as CLUMPS (many bricks move while few joints break,
		// i.e. connected 2-4-brick chunks fall together) rather than shattering into individual bricks.
		const low = await impactSignature(buildBrickWall, BRICK_WALL_CENTER.x, 8, 'brick', 30);
		const high = await impactSignature(buildBrickWall, BRICK_WALL_CENTER.x, HIGH_SPEED_APPROACH_Z, 'brick', 120);
		console.log(
			`[brick crack-vs-shatter] low(30): broken=${low.brokenJoints} bent=${low.bentJoints} moved>0.3=${low.moved03} peakDebris=${low.peakDebrisSpeed.toFixed(1)}m/s meanDisp=${low.meanDisp.toFixed(2)}m | ` +
				`high(120): broken=${high.brokenJoints} bent=${high.bentJoints} peakDebris=${high.peakDebrisSpeed.toFixed(1)}m/s meanDisp=${high.meanDisp.toFixed(2)}m`,
		);

		// HEADLINE FIX: masonry never wobbles -- no plastic-yield stage at any speed.
		expect(low.bentJoints).toBe(0);
		expect(high.bentJoints).toBe(0);

		// LOW = crack-in-CLUMPS: far more bricks move than joints break (the wall topples/sheds as a few
		// connected chunks), and debris is slow.
		expect(low.moved03).toBeGreaterThan(low.brokenJoints * 3); // clumps, not a shatter
		expect(low.peakDebrisSpeed).toBeLessThan(13);

		// HIGH = SHATTER: many mortar joints crack and debris genuinely flies.
		expect(high.brokenJoints).toBeGreaterThanOrEqual(60);
		expect(high.peakDebrisSpeed).toBeGreaterThan(18);

		// The two signatures are MEASURABLY distinct: HIGH cracks many more joints and flings debris far
		// faster than LOW (the robust separators; absolute spread is chaotic under suite allocator state).
		expect(high.brokenJoints).toBeGreaterThan(low.brokenJoints * 4);
		expect(high.peakDebrisSpeed).toBeGreaterThan(low.peakDebrisSpeed * 2);
	});

	it('brick wall: low/mid/high produce a strictly increasing debris velocity + spread signature', async () => {
		const lo = await impactSignature(buildBrickWall, BRICK_WALL_CENTER.x, 8, 'brick', 30);
		const mid = await impactSignature(buildBrickWall, BRICK_WALL_CENTER.x, 8, 'brick', 70);
		const hi = await impactSignature(buildBrickWall, BRICK_WALL_CENTER.x, HIGH_SPEED_APPROACH_Z, 'brick', 120);
		console.log(
			`[brick staged] peakDebrisSpd 30=${lo.peakDebrisSpeed.toFixed(1)} 70=${mid.peakDebrisSpeed.toFixed(1)} 120=${hi.peakDebrisSpeed.toFixed(1)} m/s | ` +
				`broken 30=${lo.brokenJoints} 70=${mid.brokenJoints} 120=${hi.brokenJoints} | meanDisp 30=${lo.meanDisp.toFixed(2)} 70=${mid.meanDisp.toFixed(2)} 120=${hi.meanDisp.toFixed(2)} m`,
		);
		// Debris VELOCITY signature rises monotonically low -> mid -> high (crisp cracking: more energy
		// cracks more joints and flings the freed bricks faster). Margins are modest because the
		// break-only model puts debris speed nearer the car's own speed than the old soft-yield model did.
		expect(mid.peakDebrisSpeed).toBeGreaterThan(lo.peakDebrisSpeed + 3);
		expect(hi.peakDebrisSpeed).toBeGreaterThan(mid.peakDebrisSpeed + 3);
		// BREAK COUNT is the robust staging signal (playtest issue #3: "keep the staging via how MANY
		// joints crack"): strictly rising with impact energy.
		expect(mid.brokenJoints).toBeGreaterThan(lo.brokenJoints);
		expect(hi.brokenJoints).toBeGreaterThan(mid.brokenJoints);
		// Both spray regimes displace materially more than the low nudge.
		expect(mid.meanDisp).toBeGreaterThan(lo.meanDisp);
		expect(hi.meanDisp).toBeGreaterThan(lo.meanDisp);
	});

	it('fence: staged debris velocity rises with impact energy (low/mid/high distinct)', async () => {
		const c = FENCE_CONFIGS[0];
		const lo = await impactSignature((w) => buildFenceLine(w, c), c.center.x, c.center.z - 10, null, 30);
		const hi = await impactSignature((w) => buildFenceLine(w, c), c.center.x, c.center.z - 10, null, 120);
		console.log(`[fence staged] peakDebrisSpd 30=${lo.peakDebrisSpeed.toFixed(1)} 120=${hi.peakDebrisSpeed.toFixed(1)} m/s broken 30=${lo.brokenJoints} 120=${hi.brokenJoints}`);
		expect(hi.peakDebrisSpeed).toBeGreaterThan(lo.peakDebrisSpeed * 1.5);
		expect(hi.brokenJoints).toBeGreaterThanOrEqual(lo.brokenJoints);
	});

	it('drywall corner: debris velocity + spread scale with impact energy (bricks vs drywall differ)', async () => {
		// Drywall is deliberately near-brittle ("punches through easily") so its BREAK count barely
		// changes with speed -- the staged signature lives in the debris velocity/spread instead.
		// Aim at the corner's front-segment midpoint (spans x in [CORNER_POINT.x - len, CORNER_POINT.x]),
		// 16m short of it -- tracks the compound-relocated CORNER_POINT rather than a hardcoded x.
		const cornerMidX = CORNER_POINT.x - CORNER_SEGMENT_LENGTH_M / 2;
		const cornerApproachZ = CORNER_POINT.z - 16;
		const lo = await impactSignature(buildHouseCorner, cornerMidX, cornerApproachZ, 'drywall', 30);
		const hi = await impactSignature(buildHouseCorner, cornerMidX, cornerApproachZ, 'drywall', 120);
		console.log(`[drywall staged] peakDebrisSpd 30=${lo.peakDebrisSpeed.toFixed(1)} 120=${hi.peakDebrisSpeed.toFixed(1)} m/s meanDisp 30=${lo.meanDisp.toFixed(2)} 120=${hi.meanDisp.toFixed(2)} m`);
		expect(hi.peakDebrisSpeed).toBeGreaterThan(lo.peakDebrisSpeed * 1.5);
		expect(hi.meanDisp).toBeGreaterThan(lo.meanDisp);
	});

	it('reset clears plastic-yield: a bent (but unbroken) ductile frame returns fully rigid', async () => {
		// Uses the SHED (a ductile wood stud frame -- WOOD_STUD_PROFILE still yields lean-then-break)
		// rather than the brick wall, which is now break-only masonry and never yields (issue #3). A gentle
		// 20km/h nudge leans several stud welds without breaking any; reset must clear that yield state.
		const world = await makeWorld();
		try {
			const s = buildShed(world);
			const vehicle = createVehicle(world, { x: SHED_CENTER.x, y: 0.5, z: SHED_CENTER.z - 8 });
			launch(vehicle, 20);
			for (let i = 0; i < 160; i++) {
				stepVehicle(vehicle, COAST, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(s);
			}
			expect(totalYieldedJointCount([s])).toBeGreaterThan(0); // it DID plastically bend
			resetStructure(world, s);
			expect(totalYieldedJointCount([s])).toBe(0);
			expect(s.joints.every((j) => j.stage === 'rigid' && !j.broken)).toBe(true);
		} finally {
			world.destroy();
		}
	});
});

describe('destruction-feel: trees lean-then-fell', () => {
	async function midImpact(speedKmh) {
		const world = await makeWorld();
		try {
			const trees = createTreesWorld(world);
			const mid = trees.mids[0];
			const site = MID_SITES[0];
			const vehicle = createVehicle(world, { x: site.x, y: 0.5, z: site.z - 8 });
			launch(vehicle, speedKmh);
			let peakTilt = 0;
			for (let i = 0; i < 200; i++) {
				stepVehicle(vehicle, { throttle: 0.15, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				stepTreesWorld(trees);
				if (!mid.broken) peakTilt = Math.max(peakTilt, trunkTiltDeg(mid.trunk));
			}
			return { broken: mid.broken, peakTilt };
		} finally {
			world.destroy();
		}
	}

	it('mid tree LEANS under a moderate hit (compliant weld) but only a fast car FELLS it', async () => {
		const moderate = await midImpact(40);
		const fast = await midImpact(80);
		console.log(`[mid lean-vs-fell] 40km/h: broken=${moderate.broken} peakLean=${moderate.peakTilt.toFixed(1)}deg | 80km/h: broken=${fast.broken}`);
		// Moderate: the trunk visibly leans (compliant root weld) but does NOT fell.
		expect(moderate.broken).toBe(false);
		expect(moderate.peakTilt).toBeGreaterThan(2);
		// Fast: the weld crosses its fell threshold and the trunk topples.
		expect(fast.broken).toBe(true);
	});
});
