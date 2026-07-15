// SPDX-License-Identifier: MIT
//
// BUGS R003/R004 -- crash visual-effects layer: window-glass shard bursts, impact dust/debris,
// tire smoke, engine-bay fluid leaks (R003), and scuff/chip decals (R004's paint-damage half).
// Self-contained, additively wired -- see game/src/main.ts + game/src/lab/main.ts's own doc
// comments at their crashFx.* call sites for the wiring.
//
// STYLE: mirrors this repo's ONE existing FX precedent, world/visuals.ts's exploding-barrel
// fireball/smoke (CanvasTexture sprite blobs, cheap, no asset downloads) -- but goes one step
// further into an actual fixed-size OBJECT POOL (that module clones+disposes a material per
// spawned sprite; this one pre-allocates every Sprite/decal-mesh + its OWN material ONCE at
// createCrashFx() time and only ever mutates them in place afterward) so a sustained multi-second
// crash can spawn hundreds of bursts without any per-event `new THREE.Sprite`/`new
// THREE.SpriteMaterial` allocation -- only per-frame-cheap property writes (position/scale/
// opacity/rotation) plus the occasional (bounded, spawn-time-only) reparent for a decal.
//
// DOM/renderer dependency: this module imports 'three' and calls `document.createElement` (via
// its own canvas-texture builders) -- both DOM-only. It is NEVER imported by damage/**,
// vehicle/**, or anything under game/sim/** (headless `vitest run` never touches THREE), so this
// is safe: the only importers are game/src/main.ts and game/src/lab/main.ts, both browser entry
// points. No top-level side effect touches the DOM either way -- everything lives inside
// createCrashFx()'s body, called once at app boot from those two files.
//
// DETERMINISM NOTE: FX are cosmetic, read-only consumers of damage events/telemetry -- they never
// feed back into physics, so the `Math.random()` jitter used throughout (shard scatter, debris
// velocity, decal rotation) cannot perturb game/sim's pinned physics assertions. Every TIME-based
// effect (particle aging, puddle growth, drip cadence, wheel-smoke cadence) is driven by an
// explicit `dt` parameter supplied by the caller (FIXED_DT in fixed-step call sites, real frame dt
// in the per-frame update() call) rather than an internal wall-clock -- this keeps a scripted
// `stepN()` verify run fully reproducible and lets a headless probe assert on frame-exact counts.

import * as THREE from 'three';
import type { DamageEvent } from '../damage/events';
import type { PanelKey } from '../damage/panels';
import type { WheelKey } from '../vehicle/vehicle';
import type { V3 } from '../vehicle/mathUtil';
import { CHASSIS_ORIGIN_HEIGHT_M } from '../vehicle/tuning';
import { FIREWALL_Z_M } from '../vehicle/geometry';
import { buildSmokeTexture } from '../world/materials';
import type { PanelVisual } from './panelVisuals';

// ---------------------------------------------------------------------------------------------
// Tuning (all FX-only -- nothing here feeds back into physics/telemetry, so no damage-tuning.ts
// entry, mirroring scene/structuralCrush.ts's own "visual-layer constants live here" convention).
// ---------------------------------------------------------------------------------------------

/** Hard cap on live particles (dust/debris/shards/smoke/drips), oldest-evicted (see the pool's
 * ring-buffer allocator doc comment below) once saturated. ROUND-2 VISIBILITY: raised 400->700 to
 * carry the denser/bigger/longer-lived bursts the eyes-on gate demanded (still fully pooled -- no
 * per-event allocation, just more pre-allocated slots). */
const MAX_PARTICLES = 700;
/** Hard cap on live scuff/chip decals, oldest-evicted the same way. Raised 60->80 for round-2's
 * every-impact scuff spawning (below). */
const MAX_DECALS = 80;

/** 'impact' events fire once per qualifying contact per fixed step (damage/system.ts already
 * floors this at its own STRESS_MIN_APPROACH_SPEED_MS) -- this is this module's OWN, independent
 * floor so a barely-there parking-lot tap doesn't kick up a dust cloud. */
const IMPACT_FX_MIN_SEVERITY_MS = 2.5;
/** Severity range (m/s) over which dust/debris count+size scale from "just crossed the floor" to
 * "full burst" -- picked so a ~90 km/h hit reads as a big burst without needing a higher-severity
 * event class. */
const IMPACT_FX_SCALE_MS = 25;
/** ROUND-2 (R004 gate FAIL: "DECAL_EVERY_N_IMPACTS=6 means decals may never spawn for a single-
 * impact crash"): the old every-Nth-event gate is GONE. A scuff now spawns on EVERY impact whose
 * severity clears this floor -- a real crash reliably scuffs the paint, a light tap still doesn't,
 * and the decal pool's own oldest-evicted cap (MAX_DECALS) keeps a sustained crush bounded. */
const DECAL_MIN_SEVERITY_MS = 3.5;
/** A scuff anchors to the nearest panel visual within this radius (m); beyond it, anchors to the
 * chassis shell (car.root) instead -- covers impacts that land on bare unibody, not a panel. */
const NEAREST_PANEL_MAX_DIST_M = 1.3;

/** Wheel surface-vs-chassis slip (m/s, Telemetry.slipHints' units) above which a grounded wheel is
 * "smoking" -- burnouts/hard launches read well past this; ordinary cornering/braking slip does not.
 * ROUND-2: lowered 3.0->2.5 so a standing-start wheelspin trips it a fraction sooner (the burnout
 * capture's slip window is short). */
const SLIP_SMOKE_MIN_MS = 2.5;
/** Slip (m/s) at which the smoke burst reaches full size/rate. */
const SLIP_SMOKE_FULL_MS = 12.0;
/** Minimum sim-time (s) between smoke puffs per wheel while smoking (a per-wheel accumulator, fed
 * by the caller's own dt -- see this module's DETERMINISM doc). */
const SMOKE_SPAWN_INTERVAL_S = 0.05;

/** Mechanical front crush, PLASTIC-only (vehicle/segments.ts's SegmentTelemetry.frontCrushPlasticM
 * -- the permanent, non-healing metric), past which the engine bay starts leaking. Comfortably
 * below the NHTSA-56 reference crash's measured ~0.33-0.44m so a standard frontal reliably leaks. */
const FLUID_LEAK_CRUSH_THRESHOLD_M = 0.22;
/** EYES-ON RETUNE: a puddle centered deep under the hood is entirely occluded by the car's own
 * body from every camera angle (top-down looks straight through the roof/hood; a low frontal shot
 * looks straight through the bumper) -- fast enough growth that a good chunk of it has spread out
 * from under the front bumper's edge by the time a crash settles (a few seconds), where it's
 * actually visible, not just numerically "present". */
// ROUND-2 (R003 gate FAIL: "fluid puddle indistinguishable from ground texture/shadow"): grows
// faster + larger so a clear glossy disc spreads out past the front bumper's edge (into open ground
// the car body doesn't occlude) within the few seconds a crash takes to settle.
const PUDDLE_GROW_RATE_M_PER_S = 0.3;
const PUDDLE_MAX_RADIUS_M = 1.7;
const DRIP_INTERVAL_S = 0.35;

// ---------------------------------------------------------------------------------------------
// Canvas-texture builders (own small variants of world/materials.ts's makeSpriteTexture -- that
// helper isn't exported, and this module's own needs -- a bright glint, a dark speck, thin
// scratch lines, a paint-chip blotch -- are different enough shapes to warrant their own small
// paint functions rather than awkwardly repurposing buildFireballTexture/buildSmokeTexture for
// everything). buildSmokeTexture ITSELF *is* reused directly (imported) for dust/tire-smoke,
// tinted per-spawn via SpriteMaterial.color -- see this module's top doc comment on why importing
// world/materials.ts's exported helpers is fine (read-only import, not an edit).
// ---------------------------------------------------------------------------------------------

function makeTexture(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	paint(ctx, size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.needsUpdate = true;
	return tex;
}

/** Bright additive speck -- glass shard "glint". */
function buildGlintTexture(size = 32): THREE.CanvasTexture {
	return makeTexture(size, (ctx) => {
		const r = size / 2;
		const g = ctx.createRadialGradient(r, r, 0, r, r, r);
		g.addColorStop(0, 'rgba(255,255,255,1)');
		g.addColorStop(0.35, 'rgba(225,238,255,0.95)');
		g.addColorStop(0.7, 'rgba(190,210,255,0.35)');
		g.addColorStop(1, 'rgba(160,190,255,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
	});
}

/** Soft dark speck -- debris chunk / fluid drip. */
function buildDebrisTexture(size = 32): THREE.CanvasTexture {
	return makeTexture(size, (ctx) => {
		const r = size / 2;
		const g = ctx.createRadialGradient(r, r, 0, r, r, r);
		g.addColorStop(0, 'rgba(20,18,15,0.95)');
		g.addColorStop(0.6, 'rgba(20,18,15,0.6)');
		g.addColorStop(1, 'rgba(20,18,15,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
	});
}

/** Diagonal scratch strokes on a transparent field -- one of 3 seeded variants. ROUND-2 (R004 gate
 * FAIL: "clean glossy black paint with NO scratch strokes even brightened 2.4x"): brighter, whiter,
 * thicker strokes on a 128px field so they actually read against near-black gloss at lab distance --
 * each bright gouge carries a dark shadow line for a real "cut into the paint" look. */
function buildScratchTexture(seed: number, size = 128): THREE.CanvasTexture {
	return makeTexture(size, (ctx) => {
		let s = seed;
		const rnd = () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return (s % 1000) / 1000;
		};
		ctx.clearRect(0, 0, size, size);
		ctx.lineCap = 'round';
		const lines = 4 + Math.floor(rnd() * 4);
		for (let i = 0; i < lines; i++) {
			const y0 = size * (0.1 + rnd() * 0.15 + i * 0.11);
			// Dark shadow line drawn FIRST (below/behind the bright stroke) -- reads as a real gouge, not
			// a flat painted-on highlight.
			ctx.strokeStyle = `rgba(15,13,11,${0.45 + rnd() * 0.3})`;
			ctx.lineWidth = 3 + rnd() * 3;
			ctx.beginPath();
			ctx.moveTo(size * 0.04, y0 + 3);
			ctx.lineTo(size * 0.96, y0 + size * 0.12 + 3);
			ctx.stroke();
			// Bright scratch -- near-white, high alpha so it survives against black gloss.
			ctx.strokeStyle = `rgba(242,244,238,${0.72 + rnd() * 0.28})`;
			ctx.lineWidth = 1.5 + rnd() * 2.5;
			ctx.beginPath();
			ctx.moveTo(size * 0.04, y0 + (rnd() - 0.5) * 8);
			ctx.lineTo(size * 0.96, y0 - (rnd() - 0.5) * 12 + size * 0.12);
			ctx.stroke();
		}
	});
}

/** An irregular paint-chip blotch: bright exposed-bare-metal center + a lighter cracked-paint rim.
 * ROUND-2: brighter (silver) exposed-metal so a chip reads as a distinct light mark against near-
 * black paint rather than dissolving into it; a scatter of small satellite chips sells "flaked". */
function buildChipTexture(seed: number, size = 128): THREE.CanvasTexture {
	return makeTexture(size, (ctx) => {
		let s = seed;
		const rnd = () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return (s % 1000) / 1000;
		};
		ctx.clearRect(0, 0, size, size);
		const cx = size * (0.42 + rnd() * 0.16);
		const cy = size * (0.42 + rnd() * 0.16);
		const rim = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.36);
		rim.addColorStop(0, 'rgba(205,208,212,0.92)');
		rim.addColorStop(0.5, 'rgba(140,140,138,0.7)');
		rim.addColorStop(1, 'rgba(120,118,114,0)');
		ctx.fillStyle = rim;
		ctx.beginPath();
		ctx.arc(cx, cy, size * 0.36, 0, Math.PI * 2);
		ctx.fill();
		// Bright bare-metal core.
		const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.18);
		core.addColorStop(0, 'rgba(225,228,232,0.98)');
		core.addColorStop(0.7, 'rgba(160,162,164,0.85)');
		core.addColorStop(1, 'rgba(120,120,120,0.3)');
		ctx.fillStyle = core;
		ctx.beginPath();
		ctx.arc(cx, cy, size * 0.18, 0, Math.PI * 2);
		ctx.fill();
		// Satellite flakes around the main chip.
		for (let i = 0; i < 5; i++) {
			const a = rnd() * Math.PI * 2;
			const d = size * (0.2 + rnd() * 0.2);
			const r = size * (0.03 + rnd() * 0.05);
			ctx.fillStyle = `rgba(200,202,205,${0.5 + rnd() * 0.4})`;
			ctx.beginPath();
			ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, Math.PI * 2);
			ctx.fill();
		}
	});
}

/** ROUND-2 (R004 gate FAIL: "bright white triangular sliver at A-pillar base = the shattered-glass
 * material swap rendering wrong"): a crazed/fractured-glass overlay -- a faint milky frost with a
 * spiderweb of white craze cracks radiating from a couple of impact origins. Applied as the swapped
 * pane's `map` by buildShatteredGlassMaterial() below so the pane reads as spider-cracked safety
 * glass, not a glowing white panel. Built lazily (first shatter) so nothing touches the DOM at module
 * load -- see this module's top doc comment. */
let _crazedGlassTex: THREE.CanvasTexture | null = null;
function crazedGlassTexture(): THREE.CanvasTexture {
	if (_crazedGlassTex) return _crazedGlassTex;
	_crazedGlassTex = makeTexture(256, (ctx, size) => {
		let s = 20260715;
		const rnd = () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return (s % 10000) / 10000;
		};
		ctx.clearRect(0, 0, size, size);
		// Faint milky frost fill (low alpha -- lets the interior read through, so it's translucent
		// cracked glass rather than an opaque panel).
		ctx.fillStyle = 'rgba(206,214,222,0.26)';
		ctx.fillRect(0, 0, size, size);
		ctx.lineCap = 'round';
		// A couple of impact origins with radial + concentric craze cracks.
		const origins = [
			[size * (0.3 + rnd() * 0.15), size * (0.35 + rnd() * 0.2)],
			[size * (0.6 + rnd() * 0.15), size * (0.55 + rnd() * 0.2)],
		];
		for (const [ox, oy] of origins) {
			const spokes = 9 + Math.floor(rnd() * 5);
			for (let i = 0; i < spokes; i++) {
				const a = (i / spokes) * Math.PI * 2 + rnd() * 0.5;
				const len = size * (0.25 + rnd() * 0.35);
				let x = ox;
				let y = oy;
				ctx.strokeStyle = `rgba(238,244,250,${0.55 + rnd() * 0.4})`;
				ctx.lineWidth = 0.8 + rnd() * 1.8;
				ctx.beginPath();
				ctx.moveTo(x, y);
				// jagged, branching radial crack
				const steps = 4 + Math.floor(rnd() * 3);
				for (let k = 0; k < steps; k++) {
					x += (Math.cos(a) * len) / steps + (rnd() - 0.5) * size * 0.03;
					y += (Math.sin(a) * len) / steps + (rnd() - 0.5) * size * 0.03;
					ctx.lineTo(x, y);
				}
				ctx.stroke();
			}
			// Concentric craze rings.
			for (let r = 0; r < 3; r++) {
				ctx.strokeStyle = `rgba(228,236,244,${0.3 + rnd() * 0.25})`;
				ctx.lineWidth = 0.6 + rnd() * 1.0;
				ctx.beginPath();
				ctx.arc(ox, oy, size * (0.06 + r * 0.07 + rnd() * 0.02), 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		// A scatter of fine background craze lines across the whole pane.
		for (let i = 0; i < 40; i++) {
			const x0 = rnd() * size;
			const y0 = rnd() * size;
			ctx.strokeStyle = `rgba(224,232,240,${0.15 + rnd() * 0.25})`;
			ctx.lineWidth = 0.5 + rnd() * 0.8;
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(x0 + (rnd() - 0.5) * size * 0.22, y0 + (rnd() - 0.5) * size * 0.22);
			ctx.stroke();
		}
	});
	_crazedGlassTex.wrapS = _crazedGlassTex.wrapT = THREE.RepeatWrapping;
	return _crazedGlassTex;
}

/** ROUND-2: build the shattered-glass material from the pane's pristine source material. Replaces
 * the old in-line swap in main.ts/lab/main.ts (which killed transmission on a white-based glass
 * material and produced a glowing WHITE panel). This tints the pane cool-milky, kills the emissive/
 * clearcoat/reflectivity that blew it white, cranks roughness (frosted, not glossy), and overlays the
 * crazedGlassTexture() spider-crack `map` so it reads as fractured safety glass. Robust even if the
 * pane mesh has no UVs (worst case: a flat translucent milky frost -- still not a white panel). */
export function buildShatteredGlassMaterial(src: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
	const m = src.clone();
	m.map = crazedGlassTexture();
	m.color.setHex(0xd7dee6); // cool milky tint (multiplies the map)
	m.roughness = 0.85;
	m.metalness = 0.0;
	if ('transmission' in m) (m as unknown as { transmission: number }).transmission = 0.0;
	if ('thickness' in m) (m as unknown as { thickness: number }).thickness = 0.0;
	if ('clearcoat' in m) (m as unknown as { clearcoat: number }).clearcoat = 0.0;
	if ('reflectivity' in m) (m as unknown as { reflectivity: number }).reflectivity = 0.12;
	if ('specularIntensity' in m) (m as unknown as { specularIntensity: number }).specularIntensity = 0.15;
	if ('ior' in m) (m as unknown as { ior: number }).ior = 1.3;
	m.emissive.setHex(0x000000);
	m.emissiveIntensity = 0;
	m.envMapIntensity = 0.25;
	m.transparent = true;
	m.opacity = 0.9;
	m.depthWrite = false;
	m.needsUpdate = true;
	return m;
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Rise-then-fall envelope in [0,1] -- same shape as world/visuals.ts's private attackDecayEnvelope,
 * kept as an independent tiny copy here rather than exporting that module's private helper. */
function attackDecay(tFrac: number, attack: number): number {
	if (tFrac <= 0 || tFrac >= 1) return 0;
	return tFrac < attack ? tFrac / attack : 1 - (tFrac - attack) / (1 - attack);
}

// ---------------------------------------------------------------------------------------------
// Particle pool
// ---------------------------------------------------------------------------------------------

type ParticleKind = 'shard' | 'dust' | 'debris' | 'smoke' | 'drip';

interface Particle {
	readonly sprite: THREE.Sprite;
	readonly material: THREE.SpriteMaterial;
	readonly vel: THREE.Vector3;
	active: boolean;
	kind: ParticleKind;
	ageS: number;
	lifeS: number;
	gravity: number;
	growPerS: number;
	baseOpacity: number;
	spin: number;
	puffy: boolean; // attack-decay fade (smoke/dust) vs a straight linear fade (debris/shard/drip)
}

interface SpawnOpts {
	texture: THREE.Texture;
	color: number;
	additive?: boolean;
	lifeS: number;
	scale: number;
	opacity: number;
	vel?: THREE.Vector3;
	gravity?: number;
	growPerS?: number;
	spin?: number;
	puffy?: boolean;
	rotation?: number;
}

export interface CrashFxCounters {
	activeParticles: number;
	decals: number;
	puddles: number;
}

export interface CrashFx {
	/** Additive subscription target -- call from inside the existing handleDamageEvent() switch in
	 * main.ts/lab/main.ts (one unconditional extra line; internally no-ops for event types this
	 * module doesn't react to). `resolveMesh` lets a glassShattered event's shard burst spawn at the
	 * ACTUAL shattered mesh's world bounds -- pass the caller's own findDeformableMesh(). */
	handleDamageEvent(event: DamageEvent, resolveMesh: (meshId: string) => THREE.Object3D | null): void;
	/** Call once per wheel per fixed step (dt = FIXED_DT) with that wheel's current world position,
	 * ground-contact state, and slip magnitude (m/s) -- spawns tire smoke while grounded+slipping. */
	updateWheel(key: WheelKey, worldPos: V3, grounded: boolean, slipMs: number, dt: number): void;
	/** Call once per fixed step (dt = FIXED_DT) with the segment telemetry's plastic front-crush
	 * depth + the chassis's current world transform -- starts/grows the engine-bay fluid leak once
	 * the crush threshold is crossed. */
	updateFluidLeak(frontCrushPlasticM: number, chassisPos: V3, chassisQuat: { x: number; y: number; z: number; w: number }, dt: number): void;
	/** Call once per RENDERED frame (real dt) -- ages/moves/fades/retires already-spawned particles.
	 * Decals and the puddle are NOT touched here (they persist until reset()/eviction). */
	update(dt: number): void;
	/** Full car repair (doCarRepair()/rebuildCarAndDamage()): clears every particle/decal/puddle --
	 * a freshly repaired car shouldn't still show the old wreck's scuffs/puddle. */
	reset(): void;
	/** VERIFY HOOK (window.__FX__): live pool occupancy, for a headless probe to assert FX actually
	 * fired (and stayed within their caps) without any pixel inspection. */
	counters(): CrashFxCounters;
	/** VERIFY/DIAGNOSTIC HOOK: every currently-active particle's world position/kind/opacity/scale --
	 * lets a headless probe confirm a burst landed somewhere actually in-frame (not, say, behind an
	 * opaque barrier mesh) without pixel inspection. */
	debugParticles(): { kind: ParticleKind; pos: [number, number, number]; opacity: number; scale: number }[];
	/** VERIFY/DIAGNOSTIC HOOK: the fluid puddle's world position + current radius (or active=false) --
	 * lets a headless probe aim the camera at the puddle to prove it's a visible disc in open ground,
	 * not a shadow under the car. */
	puddleInfo(): { active: boolean; x: number; y: number; z: number; radius: number };
}

export function createCrashFx(scene: THREE.Scene, carRoot: THREE.Object3D, panelVisuals: Record<PanelKey, PanelVisual>): CrashFx {
	const particleGroup = new THREE.Group();
	particleGroup.name = 'CrashFxParticles';
	scene.add(particleGroup);

	const decalGroup = new THREE.Group();
	decalGroup.name = 'CrashFxDecalPool'; // parking group for pooled-but-inactive decals
	scene.add(decalGroup);

	// ---- Textures (built once) ----
	const smokeTex = buildSmokeTexture();
	const glintTex = buildGlintTexture();
	const debrisTex = buildDebrisTexture();
	const scuffTextures = [buildScratchTexture(17), buildScratchTexture(53), buildScratchTexture(91), buildChipTexture(23), buildChipTexture(61), buildChipTexture(107)];

	// ---- Particle pool (fixed-size, ring-buffer allocation -- see MAX_PARTICLES's doc comment) ----
	const particles: Particle[] = [];
	for (let i = 0; i < MAX_PARTICLES; i++) {
		const material = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0 });
		const sprite = new THREE.Sprite(material);
		sprite.visible = false;
		particleGroup.add(sprite);
		particles.push({ sprite, material, vel: new THREE.Vector3(), active: false, kind: 'dust', ageS: 0, lifeS: 1, gravity: 0, growPerS: 0, baseOpacity: 1, spin: 0, puffy: false });
	}
	let particleCursor = 0;
	let activeParticleCount = 0;

	function allocParticle(): Particle {
		const p = particles[particleCursor];
		particleCursor = (particleCursor + 1) % particles.length;
		if (!p.active) activeParticleCount++;
		p.active = true;
		return p;
	}

	function spawnParticle(kind: ParticleKind, pos: THREE.Vector3, opts: SpawnOpts): void {
		const p = allocParticle();
		p.kind = kind;
		p.ageS = 0;
		p.lifeS = opts.lifeS;
		p.gravity = opts.gravity ?? 0;
		p.growPerS = opts.growPerS ?? 0;
		p.baseOpacity = opts.opacity;
		p.spin = opts.spin ?? 0;
		p.puffy = opts.puffy ?? false;
		p.vel.copy(opts.vel ?? ZERO_V);
		p.sprite.position.copy(pos);
		p.sprite.scale.setScalar(opts.scale);
		p.sprite.visible = true;
		const mat = p.material;
		mat.map = opts.texture;
		mat.color.setHex(opts.color);
		mat.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
		mat.opacity = opts.opacity;
		mat.rotation = opts.rotation ?? Math.random() * Math.PI * 2;
	}

	const ZERO_V = new THREE.Vector3();

	function updateParticles(dt: number): void {
		if (activeParticleCount === 0) return;
		for (const p of particles) {
			if (!p.active) continue;
			p.ageS += dt;
			if (p.ageS >= p.lifeS) {
				p.active = false;
				p.sprite.visible = false;
				activeParticleCount--;
				continue;
			}
			const tFrac = p.ageS / p.lifeS;
			p.vel.y -= p.gravity * dt;
			p.sprite.position.addScaledVector(p.vel, dt);
			if (p.growPerS !== 0) p.sprite.scale.addScalar(p.growPerS * dt);
			p.material.opacity = p.baseOpacity * (p.puffy ? attackDecay(tFrac, 0.25) : 1 - tFrac);
			if (p.spin !== 0) p.material.rotation += p.spin * dt;
		}
	}

	// ---- Decal pool (fixed-size, same ring-buffer allocation, PERSISTENT -- see MAX_DECALS' doc) ----
	interface DecalSlot {
		readonly mesh: THREE.Mesh;
		active: boolean;
	}
	const decalGeometry = new THREE.PlaneGeometry(1, 1);
	const decals: DecalSlot[] = [];
	for (let i = 0; i < MAX_DECALS; i++) {
		const material = new THREE.MeshBasicMaterial({
			map: scuffTextures[i % scuffTextures.length],
			transparent: true,
			depthWrite: false,
			polygonOffset: true,
			polygonOffsetFactor: -4,
			polygonOffsetUnits: -4,
			side: THREE.DoubleSide,
		});
		const mesh = new THREE.Mesh(decalGeometry, material);
		mesh.visible = false;
		decalGroup.add(mesh);
		decals.push({ mesh, active: false });
	}
	let decalCursor = 0;
	let activeDecalCount = 0;

	function allocDecal(): DecalSlot {
		const d = decals[decalCursor];
		decalCursor = (decalCursor + 1) % decals.length;
		if (!d.active) activeDecalCount++;
		d.active = true;
		return d;
	}

	const _decalInv = new THREE.Matrix4();
	function placeDecal(parent: THREE.Object3D, localPoint: THREE.Vector3): void {
		const slot = allocDecal();
		if (slot.mesh.parent !== parent) {
			slot.mesh.parent?.remove(slot.mesh);
			parent.add(slot.mesh);
		}
		const dir = localPoint.lengthSq() > 1e-6 ? localPoint.clone().normalize() : new THREE.Vector3(0, 1, 0);
		slot.mesh.position.copy(localPoint).addScaledVector(dir, 0.012);
		slot.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
		slot.mesh.rotateZ(Math.random() * Math.PI * 2);
		// ROUND-2 (R004): larger scuffs with a firm min-size floor so a single decal still reads as a
		// mark on the paint at lab distance (was 0.08-0.18m; now 0.16-0.28m).
		const s = 0.16 + Math.random() * 0.12;
		slot.mesh.scale.set(s, s, 1);
		slot.mesh.visible = true;
	}

	function findNearestPanelObject(worldPoint: THREE.Vector3): THREE.Object3D | null {
		let best: THREE.Object3D | null = null;
		let bestDist = NEAREST_PANEL_MAX_DIST_M;
		const wp = new THREE.Vector3();
		for (const visual of Object.values(panelVisuals)) {
			if (!visual) continue;
			visual.object.getWorldPosition(wp);
			const d = wp.distanceTo(worldPoint);
			if (d < bestDist) {
				bestDist = d;
				best = visual.object;
			}
		}
		return best;
	}

	function spawnScuffDecalFromWorld(worldPoint: THREE.Vector3): void {
		const parent = findNearestPanelObject(worldPoint) ?? carRoot;
		parent.updateWorldMatrix(true, false);
		_decalInv.copy(parent.matrixWorld).invert();
		const local = worldPoint.clone().applyMatrix4(_decalInv);
		placeDecal(parent, local);
	}

	function spawnChipDecalOnPanel(panel: PanelKey): void {
		const visual = panelVisuals[panel];
		if (!visual) return;
		const local = new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.22, 0.02 + Math.random() * 0.05);
		placeDecal(visual.object, local);
	}

	// ---- Puddle (single instance; ground-fixed once it starts, per this module's doc comment on
	// why a fluid leak shouldn't teleport around with a car that later drives away) ----
	// EYES-ON RETUNE: a flat unlit dark color (MeshBasicMaterial) read as visually IDENTICAL to the
	// ground's own ambient-occlusion shadow under the car -- a real fluid puddle reads as "wet" via
	// specular sheen, not just being darker, so this is a low-roughness (glossy) MeshStandardMaterial
	// instead: it stays dark under flat lighting but picks up a visible highlight/reflection the matte
	// asphalt never does, which is what actually sells "puddle" rather than "shadow" at a glance.
	// ROUND-2 (R003 gate FAIL: puddle read as ground shadow): a near-black oily fluid, but MIRROR-
	// glossy (roughness 0.04) with a touch of metalness + a strong env reflection so it picks up a
	// bright wet sheen/skylight highlight the matte asphalt (and any soft AO shadow) never can -- that
	// specular reflection, plus the sharp circular edge, is what distinguishes "fluid" from "shadow"
	// at a glance, especially from a low 3/4 angle where the reflection reads at grazing incidence.
	const puddleMaterial = new THREE.MeshStandardMaterial({
		color: 0x0b1410,
		roughness: 0.03,
		metalness: 0.3,
		envMapIntensity: 2.6,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -3,
		polygonOffsetUnits: -3,
	});
	const puddleMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 24), puddleMaterial);
	puddleMesh.rotation.x = -Math.PI / 2;
	puddleMesh.visible = false;
	scene.add(puddleMesh);
	let puddleActive = false;
	let puddleRadius = 0;
	let dripTimerS = 0;

	const _puddleLocal = new THREE.Vector3();
	const _puddleQuat = new THREE.Quaternion();
	const _puddleWorld = new THREE.Vector3();

	function updateFluidLeak(frontCrushPlasticM: number, chassisPos: V3, chassisQuat: { x: number; y: number; z: number; w: number }, dt: number): void {
		if (frontCrushPlasticM < FLUID_LEAK_CRUSH_THRESHOLD_M) return;
		if (!puddleActive) {
			// Chassis-local point roughly under the engine bay, at ground height (CHASSIS_ORIGIN_HEIGHT_M
			// is the chassis physics origin's height above the ground -- see vehicle/tuning.ts's doc --
			// so -CHASSIS_ORIGIN_HEIGHT_M + a hair is ground level in the chassis's own local frame).
			// z biased toward the front bumper (not the firewall) so the growing disc pokes out past the
			// nose rather than staying entirely hidden under the hood/engine bay from every camera angle.
			_puddleLocal.set(0, -CHASSIS_ORIGIN_HEIGHT_M + 0.025, FIREWALL_Z_M + 1.6);
			_puddleQuat.set(chassisQuat.x, chassisQuat.y, chassisQuat.z, chassisQuat.w);
			_puddleWorld.copy(_puddleLocal).applyQuaternion(_puddleQuat).add(new THREE.Vector3(chassisPos.x, chassisPos.y, chassisPos.z));
			_puddleWorld.y = lastGroundY !== null ? lastGroundY + 0.02 : Math.max(_puddleWorld.y, chassisPos.y - CHASSIS_ORIGIN_HEIGHT_M + 0.02);
			puddleMesh.position.copy(_puddleWorld);
			puddleMesh.visible = true;
			puddleActive = true;
			puddleRadius = 0.05;
		}
		puddleRadius = Math.min(PUDDLE_MAX_RADIUS_M, puddleRadius + PUDDLE_GROW_RATE_M_PER_S * dt);
		puddleMesh.scale.setScalar(puddleRadius);
		dripTimerS += dt;
		if (dripTimerS >= DRIP_INTERVAL_S) {
			dripTimerS = 0;
			spawnParticle('drip', new THREE.Vector3(puddleMesh.position.x + (Math.random() - 0.5) * 0.2, puddleMesh.position.y + 0.5, puddleMesh.position.z + (Math.random() - 0.5) * 0.2), {
				texture: debrisTex,
				color: 0x171310,
				lifeS: 0.45,
				scale: 0.06,
				gravity: 9,
				opacity: 0.95,
			});
		}
	}

	// ---- Impact dust/debris/decal ----
	let impactCounter = 0;
	function jitter(base: THREE.Vector3, radius: number): THREE.Vector3 {
		return new THREE.Vector3(base.x + (Math.random() - 0.5) * radius * 2, base.y + Math.random() * radius * 0.6, base.z + (Math.random() - 0.5) * radius * 2);
	}

	function onImpact(worldPoint: THREE.Vector3, severity: number): void {
		if (severity < IMPACT_FX_MIN_SEVERITY_MS) return;
		impactCounter++;
		const t = clamp01((severity - IMPACT_FX_MIN_SEVERITY_MS) / IMPACT_FX_SCALE_MS);
		// ROUND-2 (R003 gate FAIL: "no dust plume at impact"): denser, bigger, longer-lived, more
		// opaque dust so a real plume billows up at the impact -- readable at the ~10-15m lab camera.
		const dustCount = Math.round(6 + t * 16);
		const debrisCount = Math.round(3 + t * 8);
		for (let i = 0; i < dustCount; i++) {
			spawnParticle('dust', jitter(worldPoint, 0.45), {
				texture: smokeTex,
				color: 0xb8ac93,
				lifeS: 1.6 + Math.random() * 1.0,
				scale: 0.8 + t * 1.4 + Math.random() * 0.5,
				growPerS: 1.1,
				vel: new THREE.Vector3((Math.random() - 0.5) * 1.1, 0.6 + Math.random() * 1.3, (Math.random() - 0.5) * 1.1),
				opacity: 0.75,
				puffy: true,
			});
		}
		for (let i = 0; i < debrisCount; i++) {
			spawnParticle('debris', jitter(worldPoint, 0.2), {
				texture: debrisTex,
				color: 0x2a241d,
				lifeS: 0.55 + Math.random() * 0.5,
				scale: 0.08 + Math.random() * 0.1,
				gravity: 9,
				vel: new THREE.Vector3((Math.random() - 0.5) * 4.5, 1.2 + Math.random() * 3.2, (Math.random() - 0.5) * 4.5),
				opacity: 0.92,
			});
		}
		// ROUND-2 (R004): scuff the paint on EVERY impact that clears the severity floor (was every 6th).
		// A small lateral jitter fans successive scuffs across the panel instead of stacking them at the
		// exact same contact point, so a real crush reads as a scuffed AREA, not one dot.
		if (severity >= DECAL_MIN_SEVERITY_MS) {
			spawnScuffDecalFromWorld(jitter(worldPoint, 0.18));
		}
	}

	function onGlassShattered(mesh: THREE.Object3D | null): void {
		const center = new THREE.Vector3();
		let size = new THREE.Vector3(0.6, 0.5, 0.05);
		if (mesh) {
			mesh.updateWorldMatrix(true, false);
			const box = new THREE.Box3().setFromObject(mesh);
			if (!box.isEmpty()) {
				box.getCenter(center);
				box.getSize(size);
			} else {
				mesh.getWorldPosition(center);
			}
		} else {
			carRoot.getWorldPosition(center);
		}
		// ROUND-2 (R003 gate FAIL: "no shards visible mid-crash"): ~2x the shards, each ~3x bigger and
		// longer-lived with a wider ejection spread, so a bright additive glint spray is unmistakable at
		// lab distance instead of a handful of sub-pixel specks.
		const count = 32;
		for (let i = 0; i < count; i++) {
			const p = new THREE.Vector3(
				center.x + (Math.random() - 0.5) * Math.max(size.x, 0.3),
				center.y + (Math.random() - 0.5) * Math.max(size.y, 0.3),
				center.z + (Math.random() - 0.5) * Math.max(size.z, 0.1),
			);
			spawnParticle('shard', p, {
				texture: glintTex,
				// NORMAL-blended bright icy white (not additive): an additive white shard vanishes against
				// the bright sky the shards fly UP into; a normal-blended opaque near-white speck reads
				// against BOTH the dark car body AND the bright sky. Still bright enough to look like a glass
				// glint at lab distance.
				color: 0xe6f1ff,
				additive: false,
				lifeS: 0.9 + Math.random() * 0.8,
				scale: 0.13 + Math.random() * 0.16,
				gravity: 5,
				vel: new THREE.Vector3((Math.random() - 0.5) * 3.2, Math.random() * 1.8, (Math.random() - 0.5) * 3.2),
				opacity: 1,
				spin: (Math.random() - 0.5) * 8,
			});
		}
	}

	// ---- Tire smoke ----
	const wheelSmokeTimers: Partial<Record<WheelKey, number>> = {};
	// ROUND-3 (R003 gate: puddle rendered below the pad when the crushed nose pitched the chassis-local
	// offset under ground): track true ground height from the last grounded wheel (center minus radius)
	// so the puddle sits ON the ground regardless of chassis pitch/crush sink.
	const WHEEL_RADIUS_APPROX_M = 0.34;
	let lastGroundY: number | null = null;

	function updateWheel(key: WheelKey, worldPos: V3, grounded: boolean, slipMs: number, dt: number): void {
		if (grounded) lastGroundY = worldPos.y - WHEEL_RADIUS_APPROX_M;
		if (!grounded || slipMs < SLIP_SMOKE_MIN_MS) {
			wheelSmokeTimers[key] = 0;
			return;
		}
		const timer = (wheelSmokeTimers[key] ?? 0) + dt;
		if (timer < SMOKE_SPAWN_INTERVAL_S) {
			wheelSmokeTimers[key] = timer;
			return;
		}
		wheelSmokeTimers[key] = timer - SMOKE_SPAWN_INTERVAL_S;
		const t = clamp01((slipMs - SLIP_SMOKE_MIN_MS) / (SLIP_SMOKE_FULL_MS - SLIP_SMOKE_MIN_MS));
		// ROUND-2 (R003 gate FAIL: burnout capture "zero smoke"): bigger, slower-fading, more opaque,
		// denser puffs so a standing-start wheelspin throws a readable cloud off the driven wheels.
		const n = 2 + Math.round(t * 4);
		const base = new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z);
		for (let i = 0; i < n; i++) {
			spawnParticle('smoke', jitter(base, 0.18), {
				texture: smokeTex,
				color: 0xdedad0,
				lifeS: 1.3 + Math.random() * 1.1,
				scale: 0.5 + t * 0.7 + Math.random() * 0.35,
				growPerS: 1.6,
				vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6),
				opacity: 0.7,
				puffy: true,
			});
		}
	}

	function handleDamageEvent(event: DamageEvent, resolveMesh: (meshId: string) => THREE.Object3D | null): void {
		switch (event.type) {
			case 'impact':
				onImpact(new THREE.Vector3(event.point.x, event.point.y, event.point.z), event.severity);
				break;
			case 'glassShattered':
				onGlassShattered(resolveMesh(event.mesh));
				break;
			case 'panelBroken':
				spawnChipDecalOnPanel(event.panel);
				break;
			default:
				break;
		}
	}

	function reset(): void {
		for (const p of particles) {
			p.active = false;
			p.sprite.visible = false;
		}
		activeParticleCount = 0;
		for (const d of decals) {
			d.active = false;
			d.mesh.visible = false;
			if (d.mesh.parent !== decalGroup) {
				d.mesh.parent?.remove(d.mesh);
				decalGroup.add(d.mesh);
			}
		}
		activeDecalCount = 0;
		puddleActive = false;
		puddleRadius = 0;
		puddleMesh.visible = false;
		dripTimerS = 0;
		impactCounter = 0;
		for (const key of Object.keys(wheelSmokeTimers) as WheelKey[]) wheelSmokeTimers[key] = 0;
	}

	function counters(): CrashFxCounters {
		return { activeParticles: activeParticleCount, decals: activeDecalCount, puddles: puddleActive ? 1 : 0 };
	}

	function debugParticles(): { kind: ParticleKind; pos: [number, number, number]; opacity: number; scale: number }[] {
		const out: { kind: ParticleKind; pos: [number, number, number]; opacity: number; scale: number }[] = [];
		for (const p of particles) {
			if (!p.active) continue;
			out.push({ kind: p.kind, pos: [p.sprite.position.x, p.sprite.position.y, p.sprite.position.z], opacity: p.material.opacity, scale: p.sprite.scale.x });
		}
		return out;
	}

	function puddleInfo(): { active: boolean; x: number; y: number; z: number; radius: number } {
		return { active: puddleActive, x: puddleMesh.position.x, y: puddleMesh.position.y, z: puddleMesh.position.z, radius: puddleRadius };
	}

	return {
		handleDamageEvent,
		updateWheel,
		updateFluidLeak,
		update: updateParticles,
		reset,
		counters,
		debugParticles,
		puddleInfo,
	};
}
