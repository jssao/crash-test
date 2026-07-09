// SPDX-License-Identifier: MIT
//
// Procedural SHAPED meshes for the 39 cardetail components -- replaces the original flat box/capsule
// proxy look ("random cubes") with recognizable component silhouettes (ribbed valve cover + block
// mass + intake plenum, spiral-volute turbo + downpipe elbow, finned radiator/intercooler + tanks,
// curved hose + clamps, seat base+backrest+bolsters, torus+spokes steering wheel, etc. -- see the
// task brief / docs/build-log/specs/engine-bay-spec.md for the per-component "real-world look").
//
// CANONICAL LOCAL FRAME: every builder below works in a "canonical" frame where a component's own
// natural long axis is +Y (matching CylinderGeometry/CapsuleGeometry's default axis) for capsule-
// shaped specs, or the spec's own X=lateral/Y=up/Z=forward box frame for box-shaped specs. index.ts's
// buildMeshFor() applies the SAME final wrapper rotation the old generic code used
// (capsuleZ -> rotateX(PI/2), capsuleX -> rotateZ(PI/2)) to every capsule builder's returned group, so
// each function here never has to think in Z- or X-aligned terms itself.
//
// PHYSICS IS UNTOUCHED: every size here is read live from spec.dims (tuning.ts, LOCKED) via bx()/cp()
// below -- never a hardcoded copy -- so these visuals always stay proportioned to the real collision
// box/capsule even if tuning.ts's numbers ever shift. Per the task brief, a visual mesh may exceed its
// own collision box slightly (these are welded parts; collision fidelity is secondary to looks).
//
// DRAW-CALL DISCIPLINE: repeated same-type sub-parts (ribs, fins, terminals, bolts) are merged into
// ONE BufferGeometry via mergeGeometries() before becoming a single Mesh -- same technique + the same
// "one geometry TYPE per merge call" safety rule as trees/visuals.ts's canopy builder (mixing
// BoxGeometry with CylinderGeometry in one mergeGeometries() call has been observed elsewhere in this
// codebase to silently fail / drop attributes). Genuinely different part types (e.g. a block mass +
// a cylindrical plenum) are simply separate Mesh children instead -- correctness over shaving one more
// draw call.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarDetailMaterials } from './materials';
import type { BoxDims, CapsuleDims, CarDetailSpec } from './tuning';

function bx(spec: CarDetailSpec): BoxDims {
	return spec.dims as BoxDims;
}
function cp(spec: CarDetailSpec): CapsuleDims {
	return spec.dims as CapsuleDims;
}

/** Rotates (optional) then translates a geometry in place -- the standard "bake a local transform
 * before merge/use" idiom (matches trees/visuals.ts's geo.translate() pattern). */
function place<T extends THREE.BufferGeometry>(geo: T, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): T {
	if (rx) geo.rotateX(rx);
	if (ry) geo.rotateY(ry);
	if (rz) geo.rotateZ(rz);
	geo.translate(x, y, z);
	return geo;
}

/** Merges same-type geometry pieces into one BufferGeometry (disposes the sources) -- see this
 * file's top doc comment on why only same-type pieces are ever passed here. */
function mergeSame(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
	const merged = mergeGeometries(geos, false) ?? new THREE.BufferGeometry();
	for (const g of geos) g.dispose();
	merged.computeVertexNormals();
	return merged;
}

function addMesh(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
	const m = new THREE.Mesh(geo, mat);
	group.add(m);
	return m;
}

function box(w: number, h: number, d: number): THREE.BoxGeometry {
	return new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4));
}
function cyl(r1: number, r2: number, h: number, seg = 12): THREE.CylinderGeometry {
	return new THREE.CylinderGeometry(Math.max(r1, 1e-4), Math.max(r2, 1e-4), Math.max(h, 1e-4), seg);
}
function ring(radius: number, tube: number, radialSeg = 8, tubularSeg = 14): THREE.TorusGeometry {
	return new THREE.TorusGeometry(Math.max(radius, 1e-4), Math.max(tube, 1e-4), radialSeg, tubularSeg);
}

export type ShapeBuilder = (spec: CarDetailSpec, materials: CarDetailMaterials) => THREE.Object3D;

// ---------------------------------------------------------------------------------------------
// 1. Engine block + head — ribbed valve cover + block mass + intake plenum + runners.
// ---------------------------------------------------------------------------------------------
function buildEngineBlock(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();

	const blockH = hy * 1.25;
	addMesh(group, place(box(hx * 1.9, blockH, hz * 1.85), 0, -hy + blockH / 2, 0), materials.engineMetal);

	const coverH = hy * 0.55;
	const coverY = -hy + blockH + coverH / 2;
	const ribCount = 5;
	const ribGeos: THREE.BufferGeometry[] = [place(box(hx * 1.55, coverH, hz * 1.45), 0, coverY, 0)];
	for (let i = 0; i < ribCount; i++) {
		const t = (i / (ribCount - 1)) * 2 - 1;
		ribGeos.push(place(box(hx * 1.5, coverH * 0.24, hz * 0.14), 0, coverY + coverH * 0.52, t * hz * 0.62));
	}
	addMesh(group, mergeSame(ribGeos), materials.plasticBlackMatte);

	const plenumR = hy * 0.4;
	const plenumY = coverY + coverH / 2 + plenumR * 0.8;
	addMesh(group, place(cyl(plenumR, plenumR, hx * 1.25, 10), 0, plenumY, hz * 0.12, 0, 0, Math.PI / 2), materials.castAluminum);

	const runnerGeos: THREE.BufferGeometry[] = [];
	const runnerR = plenumR * 0.42;
	for (let i = 0; i < 4; i++) {
		const t = (i / 3) * 2 - 1;
		runnerGeos.push(place(cyl(runnerR, runnerR, hy * 0.42, 8), t * hx * 0.5, plenumY - hy * 0.16, hz * 0.05));
	}
	addMesh(group, mergeSame(runnerGeos), materials.castAluminum);

	return group;
}

// ---------------------------------------------------------------------------------------------
// 2. Turbocharger + downpipe — compressor housing (cold) + turbine housing (hot) + downpipe elbow.
// ---------------------------------------------------------------------------------------------
function buildTurbo(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();

	const compR = radius * 0.85;
	addMesh(group, place(new THREE.SphereGeometry(compR, 12, 8), 0, length * 0.24, 0), materials.castAluminum);
	// Compressor inlet snail scroll hint (small torus at the housing's face).
	addMesh(group, place(ring(compR * 0.55, compR * 0.16, 6, 12), 0, length * 0.24, compR * 0.7, Math.PI / 2), materials.castAluminum);

	const hotR = radius * 0.95;
	addMesh(group, place(new THREE.SphereGeometry(hotR, 12, 8), 0, -length * 0.2, 0), materials.castIronHot);
	// Center bearing housing joining the two.
	addMesh(group, place(cyl(radius * 0.55, radius * 0.55, length * 0.3, 10), 0, length * 0.02, 0), materials.castAluminum);

	// Downpipe: a bent tube dropping away from the hot side (down + off to one side).
	const dpR = radius * 0.45;
	const curve = new THREE.CatmullRomCurve3([
		new THREE.Vector3(0, -length * 0.45, 0),
		new THREE.Vector3(dpR * 0.3, -length * 1.1, dpR * 1.2),
		new THREE.Vector3(dpR * 0.9, -length * 1.9, dpR * 2.0),
		new THREE.Vector3(dpR * 1.1, -length * 2.6, dpR * 2.1),
	]);
	addMesh(group, new THREE.TubeGeometry(curve, 14, dpR, 8, false), materials.stainlessBrushed);
	// Exhaust manifold flange (small disc bolted to the block side, at the hot end).
	addMesh(group, place(cyl(hotR * 0.6, hotR * 0.6, radius * 0.18, 10), 0, -length * 0.55, 0), materials.stainlessBrushed);

	return group;
}

// ---------------------------------------------------------------------------------------------
// 3. Intercooler — finned bar-and-plate core + black plastic end tanks.
// ---------------------------------------------------------------------------------------------
function buildIntercooler(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	const tankW = hx * 0.16;
	addMesh(group, box(hx * 2 - tankW * 2, hy * 1.9, hz * 1.7), materials.radiatorFin);
	const tankGeos = [place(box(tankW * 1.8, hy * 2.05, hz * 2.1), hx - tankW * 0.9, 0, 0), place(box(tankW * 1.8, hy * 2.05, hz * 2.1), -hx + tankW * 0.9, 0, 0)];
	addMesh(group, mergeSame(tankGeos), materials.plasticBlackMatte);
	// Charge-pipe couplers stubbing out of each tank.
	const couplerGeos = [
		place(cyl(hy * 0.32, hy * 0.32, hz * 0.9, 8), hx * 0.85, 0, 0, 0, 0, Math.PI / 2),
		place(cyl(hy * 0.32, hy * 0.32, hz * 0.9, 8), -hx * 0.85, 0, 0, 0, 0, Math.PI / 2),
	];
	addMesh(group, mergeSame(couplerGeos), materials.rubberBlack);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 4. Radiator + cooling fan — finned core + top/bottom tanks + fan blades + shroud ring.
// ---------------------------------------------------------------------------------------------
function buildRadiatorFan(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	const tankH = hy * 0.18;
	addMesh(group, box(hx * 1.85, hy * 2 - tankH * 2, hz * 1.6), materials.radiatorFin);
	const tankGeos = [place(box(hx * 1.95, tankH * 1.9, hz * 1.9), 0, hy - tankH * 0.9, 0), place(box(hx * 1.95, tankH * 1.9, hz * 1.9), 0, -hy + tankH * 0.9, 0)];
	addMesh(group, mergeSame(tankGeos), materials.plasticBlackMatte);

	// Fan sits behind the core (toward the engine, -Z), a hub + radial blades + a shroud ring.
	const fanZ = -hz * 1.35;
	const fanR = Math.min(hx, hy) * 0.75;
	addMesh(group, place(cyl(fanR * 0.16, fanR * 0.16, hz * 0.5, 10), 0, 0, fanZ, Math.PI / 2), materials.plasticBlackGloss);
	const bladeGeos: THREE.BufferGeometry[] = [];
	const bladeCount = 7;
	for (let i = 0; i < bladeCount; i++) {
		const a = (i / bladeCount) * Math.PI * 2;
		const g = place(box(fanR * 0.28, hz * 0.4, fanR * 0.85), 0, 0, 0, 0, 0, 0);
		g.rotateZ(a);
		g.translate(Math.cos(a) * fanR * 0.5, Math.sin(a) * fanR * 0.5, fanZ);
		bladeGeos.push(g);
	}
	addMesh(group, mergeSame(bladeGeos), materials.plasticBlackGloss);
	addMesh(group, place(ring(fanR * 1.05, fanR * 0.08, 6, 16), 0, 0, fanZ, Math.PI / 2), materials.plasticBlackMatte);

	return group;
}

// ---------------------------------------------------------------------------------------------
// 5/6. Radiator hoses — curved rubber tube + wire-clamp rings near each end.
// ---------------------------------------------------------------------------------------------
function buildHose(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();
	const half = length / 2;
	const bend = radius * 3.2;
	const curve = new THREE.CatmullRomCurve3([
		new THREE.Vector3(0, -half, 0),
		new THREE.Vector3(bend * 0.6, -half * 0.35, bend * 0.3),
		new THREE.Vector3(-bend * 0.3, half * 0.35, -bend * 0.2),
		new THREE.Vector3(0, half, 0),
	]);
	addMesh(group, new THREE.TubeGeometry(curve, 16, radius, 8, false), materials.rubberBlack);
	const clampGeos = [place(ring(radius * 1.18, radius * 0.3, 6, 12), 0, -half * 0.72, 0), place(ring(radius * 1.18, radius * 0.3, 6, 12), 0, half * 0.72, 0)];
	addMesh(group, mergeSame(clampGeos), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 7. Intake assembly — airbox + charge pipe + throttle body, one rigid unit.
// ---------------------------------------------------------------------------------------------
function buildIntakeAssembly(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	// Airbox occupies the rear (-Z) half.
	addMesh(group, place(box(hx * 1.7, hy * 1.6, hz * 0.85), 0, -hy * 0.05, -hz * 0.5), materials.plasticBlackMatte);
	// Charge pipe curving from the airbox toward the throttle body at +Z.
	const pipeR = Math.min(hx, hy) * 0.28;
	const curve = new THREE.CatmullRomCurve3([
		new THREE.Vector3(hx * 0.2, hy * 0.1, -hz * 0.65),
		new THREE.Vector3(hx * 0.35, hy * 0.35, 0),
		new THREE.Vector3(hx * 0.1, hy * 0.2, hz * 0.6),
	]);
	addMesh(group, new THREE.TubeGeometry(curve, 14, pipeR, 8, false), materials.aluAnodizedBlue);
	// Rubber couplers at each pipe end.
	const couplerGeos = [place(ring(pipeR * 1.2, pipeR * 0.35, 6, 10), hx * 0.2, hy * 0.1, -hz * 0.65), place(ring(pipeR * 1.2, pipeR * 0.35, 6, 10), hx * 0.1, hy * 0.2, hz * 0.6)];
	addMesh(group, mergeSame(couplerGeos), materials.rubberBlack);
	// Throttle body at the +Z end.
	addMesh(group, place(cyl(hy * 0.3, hy * 0.3, hz * 0.3, 10), hx * 0.05, hy * 0.15, hz * 0.75, Math.PI / 2), materials.castAluminum);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 8. Battery — case + 2 terminal posts + warning-label decal strip.
// ---------------------------------------------------------------------------------------------
function buildBattery(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.9, hy * 1.9, hz * 1.9), materials.plasticBlackGloss);
	const termGeos = [place(cyl(hy * 0.18, hy * 0.18, hy * 0.32, 8), hx * 0.5, hy * 0.85, hz * 0.4), place(cyl(hy * 0.18, hy * 0.18, hy * 0.32, 8), -hx * 0.5, hy * 0.85, hz * 0.4)];
	addMesh(group, mergeSame(termGeos), materials.steelBrushed);
	addMesh(group, place(box(hx * 1.2, hy * 0.5, hz * 0.02), 0, hy * 0.1, hz * 0.96), materials.labelYellow);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 9. Brake master cylinder + booster — matte drum + cast MC + reservoir cap.
// ---------------------------------------------------------------------------------------------
function buildBrakeBoosterMC(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	const drumR = Math.min(hx, hy) * 0.95;
	addMesh(group, place(cyl(drumR, drumR, hz * 1.5, 12), 0, 0, -hz * 0.15, Math.PI / 2), materials.plasticBlackMatte);
	const mcR = drumR * 0.6;
	addMesh(group, place(cyl(mcR, mcR, hz * 1.1, 10), 0, hy * 0.25, hz * 0.55, Math.PI / 2), materials.castAluminum);
	addMesh(group, place(cyl(mcR * 0.5, mcR * 0.5, hy * 0.4, 8), 0, hy * 0.75, hz * 0.55), materials.plasticBlackMatte);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 10. Strut brace — bar + end plates + rubber isolator pucks.
// ---------------------------------------------------------------------------------------------
function buildStrutBrace(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();
	addMesh(group, cyl(radius, radius, length * 0.86, 12), materials.aluAnodizedBlue);
	const half = length / 2;
	const plateGeos = [place(cyl(radius * 2.1, radius * 2.1, radius * 0.4, 12), 0, half * 0.92, 0), place(cyl(radius * 2.1, radius * 2.1, radius * 0.4, 12), 0, -half * 0.92, 0)];
	addMesh(group, mergeSame(plateGeos), materials.steelBrushed);
	const puckGeos = [place(cyl(radius * 1.5, radius * 1.5, radius * 0.5, 10), 0, half, 0), place(cyl(radius * 1.5, radius * 1.5, radius * 0.5, 10), 0, -half, 0)];
	addMesh(group, mergeSame(puckGeos), materials.rubberBlack);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 11. Alternator — finned cylinder body + pulley + hub.
// ---------------------------------------------------------------------------------------------
function buildAlternator(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	const bodyR = Math.min(hx, hy) * 0.92;
	addMesh(group, place(cyl(bodyR, bodyR, hz * 1.7, 12), 0, 0, 0, Math.PI / 2), materials.castAluminum);
	const finGeos: THREE.BufferGeometry[] = [];
	for (let i = -1; i <= 1; i++) {
		finGeos.push(place(ring(bodyR * 1.02, bodyR * 0.06, 6, 16), 0, 0, i * hz * 0.5, Math.PI / 2));
	}
	addMesh(group, mergeSame(finGeos), materials.castAluminum);
	addMesh(group, place(ring(bodyR * 0.6, bodyR * 0.22, 8, 14), 0, 0, hz * 0.95, Math.PI / 2), materials.plasticBlackGloss);
	addMesh(group, place(cyl(bodyR * 0.15, bodyR * 0.15, hz * 0.3, 8), 0, 0, hz * 1.1, Math.PI / 2), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 12. Coolant + washer reservoir — twin translucent bottles + caps.
// ---------------------------------------------------------------------------------------------
function buildReservoir(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy } = bx(spec);
	const group = new THREE.Group();
	const bottleR = hx * 0.46;
	addMesh(group, place(cyl(bottleR, bottleR * 1.1, hy * 1.8, 10), -hx * 0.48, 0, 0), materials.plasticTranslucentWhite);
	addMesh(group, place(cyl(bottleR, bottleR * 1.1, hy * 1.8, 10), hx * 0.48, 0, 0), materials.plasticTranslucentBlue);
	const capGeos = [place(cyl(bottleR * 0.4, bottleR * 0.4, hy * 0.25, 8), -hx * 0.48, hy * 1.02, 0), place(cyl(bottleR * 0.4, bottleR * 0.4, hy * 0.25, 8), hx * 0.48, hy * 1.02, 0)];
	addMesh(group, mergeSame(capGeos), materials.plasticBlackMatte);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 13. Fuse box — lidded box + warning decal + relay/fuse terminal bumps.
// ---------------------------------------------------------------------------------------------
function buildFuseBox(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.9, hy * 1.6, hz * 1.9), materials.plasticBlackMatte);
	addMesh(group, place(box(hx * 1.98, hy * 0.55, hz * 1.98), 0, hy * 0.7, 0), materials.plasticBlackGloss);
	addMesh(group, place(box(hx * 0.9, hy * 0.02, hz * 0.6), 0, hy * 1.0, -hz * 0.5), materials.labelYellow);
	const nubGeos: THREE.BufferGeometry[] = [];
	for (let i = 0; i < 6; i++) {
		const t = (i / 5) * 2 - 1;
		nubGeos.push(place(box(hx * 0.16, hy * 0.14, hz * 0.16), t * hx * 0.7, hy * 1.02, hz * 0.35));
	}
	addMesh(group, mergeSame(nubGeos), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 14/15/16. Seats / rear bench — base cushion + backrest + side bolsters + headrest(s).
// ---------------------------------------------------------------------------------------------
function buildSeatLike(spec: CarDetailSpec, materials: CarDetailMaterials, headrestCount: number): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	const baseH = hy * 0.62;
	const baseY = -hy + baseH / 2;
	addMesh(group, place(box(hx * 1.85, baseH, hz * 1.9), 0, baseY, hz * 0.05), materials.clothBlack);
	const backH = hy * 1.5;
	const backZ = -hz * 0.75;
	addMesh(group, place(box(hx * 1.85, backH, hz * 0.55), 0, -hy + baseH * 0.3 + backH / 2, backZ), materials.clothBlack);
	// Side bolsters -- raised ridges along both edges of cushion + backrest.
	const bolsterGeos = [
		place(box(hx * 0.22, baseH * 1.35, hz * 1.9), hx * 0.85, baseY + baseH * 0.15, hz * 0.05),
		place(box(hx * 0.22, baseH * 1.35, hz * 1.9), -hx * 0.85, baseY + baseH * 0.15, hz * 0.05),
		place(box(hx * 0.22, backH * 0.95, hz * 0.6), hx * 0.85, -hy + baseH * 0.3 + backH / 2, backZ),
		place(box(hx * 0.22, backH * 0.95, hz * 0.6), -hx * 0.85, -hy + baseH * 0.3 + backH / 2, backZ),
	];
	addMesh(group, mergeSame(bolsterGeos), materials.clothBlack);
	// Thin contrast-stitch lines along the cushion's front edge and backrest center.
	const stitchGeos = [
		place(box(hx * 1.7, hy * 0.02, hz * 0.02), 0, baseY + baseH / 2, hz * 0.05 + hz * 0.95),
		place(box(hx * 0.03, backH * 0.9, hz * 0.03), 0, -hy + baseH * 0.3 + backH / 2, backZ + hz * 0.28),
	];
	addMesh(group, mergeSame(stitchGeos), materials.stitchRed);
	// Headrest(s) on top of the backrest.
	const headGeos: THREE.BufferGeometry[] = [];
	for (let i = 0; i < headrestCount; i++) {
		const t = headrestCount === 1 ? 0 : (i / (headrestCount - 1)) * 2 - 1;
		const cx = headrestCount === 1 ? 0 : t * hx * 0.5;
		headGeos.push(place(box(hx * (headrestCount === 1 ? 1.1 : 0.5), hy * 0.28, hz * 0.4), cx, hy * 0.9, backZ + hz * 0.05));
	}
	addMesh(group, mergeSame(headGeos), materials.clothBlack);
	return group;
}
function buildSeat(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	return buildSeatLike(spec, materials, 1);
}
function buildRearBench(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	return buildSeatLike(spec, materials, 2);
}

// ---------------------------------------------------------------------------------------------
// 17. Dashboard — soft-touch pad + instrument binnacle (driver side) + carbon-look trim ring.
// ---------------------------------------------------------------------------------------------
function buildDashboard(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.9, hy * 1.8, hz * 1.7), materials.plasticBlackMatte);
	// Binnacle bulges toward the driver (this project's LHD convention -> local -X) and forward/up.
	const binX = -hx * 0.55;
	const binR = hy * 0.55;
	addMesh(group, place(cyl(binR, binR * 1.05, hz * 0.9, 12), binX, hy * 0.15, hz * 0.5, Math.PI / 2), materials.plasticBlackMatte);
	addMesh(group, place(ring(binR * 0.92, binR * 0.1, 6, 16), binX, hy * 0.15, hz * 0.9, Math.PI / 2), materials.plasticBlackGloss);
	// A couple of vent slots for detail.
	const ventGeos: THREE.BufferGeometry[] = [];
	for (let i = 0; i < 2; i++) {
		const t = i === 0 ? 1 : -1;
		ventGeos.push(place(box(hx * 0.4, hy * 0.08, hz * 0.05), t * hx * 0.3, hy * 0.75, hz * 0.85));
	}
	addMesh(group, mergeSame(ventGeos), materials.plasticBlackGloss);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 18. Steering wheel + column — canonical Y-axis capsule; wheel rim/spokes at +Y (forward/cabin end).
// ---------------------------------------------------------------------------------------------
function buildSteeringColumn(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();
	addMesh(group, cyl(radius, radius * 1.15, length * 0.82, 10), materials.plasticBlackMatte);
	const wheelR = radius * 8.4;
	const wheelY = length / 2;
	addMesh(group, place(ring(wheelR, wheelR * 0.1, 8, 22), 0, wheelY, 0), materials.clothBlack);
	const spokeGeos: THREE.BufferGeometry[] = [];
	for (let i = 0; i < 3; i++) {
		const a = (i / 3) * Math.PI * 2;
		const g = box(wheelR * 1.65, radius * 1.6, radius * 1.3);
		g.rotateZ(a + Math.PI / 2);
		g.translate(Math.cos(a) * wheelR * 0.5, wheelY + Math.sin(a) * wheelR * 0.5, 0);
		spokeGeos.push(g);
	}
	addMesh(group, mergeSame(spokeGeos), materials.steelBrushed);
	addMesh(group, place(cyl(radius * 1.8, radius * 1.8, radius * 1.2, 10), 0, wheelY, 0), materials.plasticBlackGloss);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 19. Center console + shifter — box + trim strip + shifter stem/knob.
// ---------------------------------------------------------------------------------------------
function buildCenterConsole(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.9, hy * 1.9, hz * 1.9), materials.plasticBlackGloss);
	addMesh(group, place(box(hx * 1.3, hy * 0.06, hz * 1.5), 0, hy * 1.0, 0), materials.steelBrushed);
	const stemR = hy * 0.14;
	addMesh(group, place(cyl(stemR, stemR, hy * 0.8, 8), 0, hy * 1.35, hz * 0.15), materials.steelBrushed);
	addMesh(group, place(new THREE.SphereGeometry(stemR * 2.1, 10, 8), 0, hy * 1.75, hz * 0.15), materials.plasticBlackGloss);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 20. Pedal cluster — housing box + brushed pedal faces angled up toward the driver.
// ---------------------------------------------------------------------------------------------
function buildPedalCluster(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.7, hy * 1.7, hz * 1.3), materials.steelMattePowder);
	const pedalGeos: THREE.BufferGeometry[] = [];
	for (let i = 0; i < 3; i++) {
		const t = (i / 2) * 2 - 1;
		const g = box(hx * 0.42, hy * 1.3, hz * 0.1);
		g.rotateX(-0.35);
		g.translate(t * hx * 0.55, hy * 0.2, hz * 0.75);
		pedalGeos.push(g);
	}
	addMesh(group, mergeSame(pedalGeos), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 21. Rearview mirror — housing + silvered glass lens.
// ---------------------------------------------------------------------------------------------
function buildRearviewMirror(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.9, hy * 1.9, hz * 1.6), materials.plasticBlackMatte);
	addMesh(group, place(box(hx * 1.6, hy * 1.5, hz * 0.15), 0, 0, hz * 0.95), materials.lensClear);
	addMesh(group, place(cyl(hy * 0.35, hy * 0.35, hz * 0.5, 8), 0, -hy * 1.0, -hz * 0.3), materials.plasticBlackMatte);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 22. Catalytic converter — capsule canister + flange rings at both ends.
// ---------------------------------------------------------------------------------------------
function buildCatConverter(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();
	addMesh(group, cyl(radius, radius, length * 0.88, 12), materials.stainlessBrushed);
	const half = length / 2;
	const flangeGeos = [place(ring(radius * 0.95, radius * 0.18, 6, 14), 0, half * 0.9, 0), place(ring(radius * 0.95, radius * 0.18, 6, 14), 0, -half * 0.9, 0)];
	addMesh(group, mergeSame(flangeGeos), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 23. Muffler + tailpipe — canister slab (visual cylinder, box collision) + chrome tip.
// ---------------------------------------------------------------------------------------------
function buildMufflerTailpipe(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	const canR = Math.min(hx, hy) * 0.95;
	addMesh(group, place(cyl(canR, canR, hz * 1.55, 12), 0, 0, -hz * 0.15, Math.PI / 2), materials.stainlessBrushed);
	const tipR = canR * 0.35;
	addMesh(group, place(cyl(tipR, tipR * 1.1, hz * 0.55, 10), 0, -hy * 0.15, hz * 1.05, Math.PI / 2), materials.chromeBright);
	addMesh(group, place(ring(canR * 0.98, canR * 0.1, 6, 16), 0, 0, hz * 0.55, Math.PI / 2), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 24. Fuel tank — saddle-shaped shell + retaining straps.
// ---------------------------------------------------------------------------------------------
function buildFuelTank(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.9, hy * 1.8, hz * 1.9), materials.steelMattePowder);
	const strapGeos = [place(box(hx * 1.95, hy * 0.14, hz * 1.95), 0, hy * 0.55, 0, 0, 0, 0), place(box(hx * 1.95, hy * 0.14, hz * 1.95), 0, -hy * 0.55, 0, 0, 0, 0)];
	addMesh(group, mergeSame(strapGeos), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 25/26. Subframes — flat cradle-plate look with corner mounting bosses.
// ---------------------------------------------------------------------------------------------
function buildSubframe(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	// Perimeter rails (a thin rectangular "cradle" ring) instead of a solid slab.
	const railT = hx * 0.22;
	const railGeos = [
		place(box(hx * 2, hy * 1.7, railT), 0, 0, hz * 0.9),
		place(box(hx * 2, hy * 1.7, railT), 0, 0, -hz * 0.9),
		place(box(railT, hy * 1.7, hz * 2), hx * 0.9, 0, 0),
		place(box(railT, hy * 1.7, hz * 2), -hx * 0.9, 0, 0),
		place(box(hx * 1.4, hy * 1.1, hz * 1.4), 0, -hy * 0.15, 0), // center cross-brace mass
	];
	addMesh(group, mergeSame(railGeos), materials.steelMattePowder);
	const bossGeos: THREE.BufferGeometry[] = [];
	for (const sx of [-1, 1]) {
		for (const sz of [-1, 1]) {
			bossGeos.push(place(cyl(hy * 0.5, hy * 0.5, hy * 0.5, 8), sx * hx * 0.85, hy * 0.6, sz * hz * 0.85));
		}
	}
	addMesh(group, mergeSame(bossGeos), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 27. Driveshaft — bare steel tube + U-joint yokes at both ends.
// ---------------------------------------------------------------------------------------------
function buildDriveshaft(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();
	addMesh(group, cyl(radius, radius, length * 0.9, 10), materials.steelBrushed);
	const half = length / 2;
	const yokeGeos: THREE.BufferGeometry[] = [];
	for (const s of [-1, 1]) {
		const y = s * half * 0.94;
		yokeGeos.push(place(box(radius * 3.2, radius * 1.1, radius * 1.1), 0, y, 0));
		yokeGeos.push(place(box(radius * 1.1, radius * 1.1, radius * 3.2), 0, y, 0));
	}
	addMesh(group, mergeSame(yokeGeos), materials.plasticBlackMatte);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 28-31. Lower control arms — A-arm taper from a wide inner bushing pair to an outer ball joint.
// ---------------------------------------------------------------------------------------------
function buildControlArm(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	// Two tapered arms converging from the inner (−X, toward the subframe centerline) bushings to a
	// single outer (+X, toward the hub) ball joint.
	const armGeos: THREE.BufferGeometry[] = [];
	for (const s of [-1, 1]) {
		const g = box(hx * 1.85, hy * 0.9, hz * (0.55 + 0.35));
		g.translate(0, 0, s * hz * 0.28);
		// Taper the outer half toward the ball joint by scaling depth near +X via a second box instead
		// (BoxGeometry can't taper natively) -- approximate with two stacked boxes: wide inner, narrow outer.
		armGeos.push(place(box(hx * 1.0, hy * 0.9, hz * 0.55), -hx * 0.4, 0, s * hz * 0.35));
		armGeos.push(place(box(hx * 1.0, hy * 0.85, hz * 0.32), hx * 0.45, 0, s * hz * 0.18));
	}
	addMesh(group, mergeSame(armGeos), materials.steelBrushed);
	const bushGeos = [place(cyl(hy * 0.55, hy * 0.55, hz * 0.5, 8), -hx * 0.92, 0, hz * 0.35, 0, 0, Math.PI / 2), place(cyl(hy * 0.55, hy * 0.55, hz * 0.5, 8), -hx * 0.92, 0, -hz * 0.35, 0, 0, Math.PI / 2)];
	addMesh(group, mergeSame(bushGeos), materials.rubberBlack);
	addMesh(group, place(new THREE.SphereGeometry(hy * 0.65, 10, 8), hx * 0.92, 0, 0), materials.steelBrushed);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 32/33. Bumper beams — canonical Y-axis bar with visible crush-can ribbing + crash-box mounts.
// ---------------------------------------------------------------------------------------------
function buildBumperBeam(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { length, radius } = cp(spec);
	const group = new THREE.Group();
	addMesh(group, cyl(radius, radius, length * 0.94, 10), materials.steelMattePowder);
	const ribGeos: THREE.BufferGeometry[] = [];
	const ribCount = 7;
	for (let i = 0; i < ribCount; i++) {
		const t = (i / (ribCount - 1)) * 2 - 1;
		ribGeos.push(place(ring(radius * 1.06, radius * 0.12, 6, 14), 0, t * length * 0.42, 0, Math.PI / 2));
	}
	addMesh(group, mergeSame(ribGeos), materials.steelBrushed);
	const half = length / 2;
	const mountGeos = [place(box(radius * 1.5, radius * 1.5, radius * 1.9), 0, half * 0.85, 0), place(box(radius * 1.5, radius * 1.5, radius * 1.9), 0, -half * 0.85, 0)];
	addMesh(group, mergeSame(mountGeos), materials.steelMattePowder);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 34/35. Headlights — domed clear lens over a black projector housing + chrome bezel.
// ---------------------------------------------------------------------------------------------
function buildHeadlight(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, place(box(hx * 1.8, hy * 1.8, hz * 1.4), 0, 0, -hz * 0.2), materials.plasticBlackMatte);
	addMesh(group, place(cyl(hy * 0.6, hy * 0.6, hz * 0.4, 10), 0, 0, hz * 0.55, Math.PI / 2), materials.castAluminum);
	addMesh(group, place(new THREE.SphereGeometry(Math.min(hx, hy) * 0.95, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), 0, 0, hz * 0.55), materials.lensClear);
	addMesh(group, place(ring(Math.min(hx, hy) * 0.98, hy * 0.08, 6, 16), 0, 0, hz * 0.9), materials.chromeBright);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 36/37. Taillights — red/clear lens over a black housing.
// ---------------------------------------------------------------------------------------------
function buildTaillight(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.85, hy * 1.85, hz * 1.4), materials.plasticBlackMatte);
	addMesh(group, place(box(hx * 1.5, hy * 1.5, hz * 0.35), 0, 0, -hz * 0.85), materials.lensRed);
	const barGeos: THREE.BufferGeometry[] = [];
	for (let i = -1; i <= 1; i++) {
		barGeos.push(place(box(hx * 1.4, hy * 0.08, hz * 0.05), 0, i * hy * 0.4, -hz * 1.02));
	}
	addMesh(group, mergeSame(barGeos), materials.plasticBlackGloss);
	return group;
}

// ---------------------------------------------------------------------------------------------
// 38/39. Side mirrors — body-color housing + silvered glass + chrome bezel + breakaway stalk.
// ---------------------------------------------------------------------------------------------
function buildSideMirror(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Group {
	const { hx, hy, hz } = bx(spec);
	const group = new THREE.Group();
	addMesh(group, box(hx * 1.8, hy * 1.7, hz * 1.7), materials.paintGeneric);
	addMesh(group, place(box(hx * 1.3, hy * 1.3, hz * 0.1), 0, 0, -hz * 0.92), materials.lensClear);
	addMesh(group, place(ring(Math.min(hy, hz) * 0.75, hy * 0.06, 6, 14), 0, 0, -hz * 0.95), materials.chromeBright);
	addMesh(group, place(cyl(hy * 0.22, hy * 0.3, hx * 0.5, 8), hx * 0.75, 0, 0, 0, 0, Math.PI / 2), materials.paintGeneric);
	return group;
}

// ---------------------------------------------------------------------------------------------
// Dispatch table (index.ts's buildMeshFor keys on spec.id).
// ---------------------------------------------------------------------------------------------
export const SHAPE_BUILDERS: Readonly<Record<string, ShapeBuilder>> = {
	engineBlock: buildEngineBlock,
	turboDownpipe: buildTurbo,
	intercooler: buildIntercooler,
	radiatorFan: buildRadiatorFan,
	upperHose: buildHose,
	lowerHose: buildHose,
	intakeAssembly: buildIntakeAssembly,
	battery: buildBattery,
	brakeBoosterMC: buildBrakeBoosterMC,
	strutBrace: buildStrutBrace,
	alternator: buildAlternator,
	coolantReservoir: buildReservoir,
	fuseBox: buildFuseBox,
	driverSeat: buildSeat,
	passengerSeat: buildSeat,
	rearBench: buildRearBench,
	dashboard: buildDashboard,
	steeringColumn: buildSteeringColumn,
	centerConsole: buildCenterConsole,
	pedalCluster: buildPedalCluster,
	rearviewMirror: buildRearviewMirror,
	catConverter: buildCatConverter,
	mufflerTailpipe: buildMufflerTailpipe,
	fuelTank: buildFuelTank,
	frontSubframe: buildSubframe,
	rearSubframe: buildSubframe,
	driveshaft: buildDriveshaft,
	flControlArm: buildControlArm,
	frControlArm: buildControlArm,
	rlControlArm: buildControlArm,
	rrControlArm: buildControlArm,
	frontBumperBeam: buildBumperBeam,
	rearBumperBeam: buildBumperBeam,
	headlightL: buildHeadlight,
	headlightR: buildHeadlight,
	taillightL: buildTaillight,
	taillightR: buildTaillight,
	mirrorL: buildSideMirror,
	mirrorR: buildSideMirror,
};
