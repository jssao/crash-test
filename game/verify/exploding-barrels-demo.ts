// SPDX-License-Identifier: MIT
//
// EYES-ON VERIFY ONLY -- not part of the game, not linked from index.html, not touching main.ts (see
// world/bodies.ts's WIRING doc comment on why: main.ts is reserved to a different concurrent worker
// per this run's STRICT OWNERSHIP). A minimal standalone THREE scene, served by the SAME `vite dev`
// server as the real game (vite dev serves any .html under the project root, not just index.html),
// that builds the real destructible world + real exploding-barrels physics/visuals and drives a
// scripted crash into the barrel triangle so a screenshot can show the fireball/smoke burst live.
//
// Usage: from game/, `npx vite` (dev server), then open /verify/exploding-barrels-demo.html --
// window.__BARREL_DEMO__.stepN(n) drives n fixed steps; a CDP script (verify/shoot-exploding-
// barrels.mjs) drives it headlessly and screenshots mid-chain.

import * as THREE from 'three';
import { init, World } from '../../src/ts/index.js';
import { createGroundBody, createVehicle, stepVehicle, NEUTRAL_INPUT } from '../src/vehicle/vehicle';
import { crashSetup } from '../src/damage/scenario';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning';
import { createDestructibleWorld, resetDestructibleWorld, stepExplodingBarrels, type DestructibleWorld } from '../src/world/bodies';
import {
	buildDestructibleVisuals,
	sampleDestructibleVisuals,
	applyDestructibleVisuals,
	spawnExplosionEffects,
	stepExplosionEffects,
	type DestructibleVisualBundle,
} from '../src/world/visuals';
import { BARREL_TRIANGLE_APEX } from '../src/world/tuning';

declare global {
	interface Window {
		__BARREL_DEMO__?: {
			ready: boolean;
			stepN: (n: number) => void;
			crash: (speedKmh: number) => void;
			resetWorld: () => void;
			explodedCount: () => number;
		};
	}
}

async function main() {
	const renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	document.body.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x8fb6d9);
	scene.fog = new THREE.Fog(0x8fb6d9, 40, 140);

	const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
	camera.position.set(BARREL_TRIANGLE_APEX.x + 20, 12, BARREL_TRIANGLE_APEX.z - 16);
	camera.lookAt(BARREL_TRIANGLE_APEX.x, 1, BARREL_TRIANGLE_APEX.z + 2);

	scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.1));
	const sun = new THREE.DirectionalLight(0xffffff, 2.2);
	sun.position.set(30, 40, 10);
	scene.add(sun);

	const groundMesh = new THREE.Mesh(
		new THREE.PlaneGeometry(400, 400),
		new THREE.MeshStandardMaterial({ color: 0x4a5a44, roughness: 1 }),
	);
	groundMesh.rotation.x = -Math.PI / 2;
	scene.add(groundMesh);

	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world);

	const spawnPosition = { x: BARREL_TRIANGLE_APEX.x, y: CHASSIS_ORIGIN_HEIGHT_M, z: BARREL_TRIANGLE_APEX.z - 8 };
	const vehicle = createVehicle(world, spawnPosition);

	const destructible: DestructibleWorld = createDestructibleWorld(world);
	const visuals: DestructibleVisualBundle = buildDestructibleVisuals(destructible);
	scene.add(visuals.group);

	// A plain box stand-in for the car body (this demo has no GLB car model -- see main.ts for the
	// real one) so the screenshot reads as "something drove into the barrels", not just floating fire.
	const carBox = new THREE.Mesh(
		new THREE.BoxGeometry(1.9, 1.3, 4.4),
		new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.4, metalness: 0.3 }),
	);
	scene.add(carBox);

	function syncCarBox() {
		const t = vehicle.chassis.getTransform();
		carBox.position.set(t.position.x, t.position.y, t.position.z);
		carBox.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	}
	syncCarBox();

	function fixedStep() {
		stepVehicle(vehicle, NEUTRAL_INPUT, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const events = stepExplodingBarrels(world, destructible, FIXED_DT);
		spawnExplosionEffects(visuals, events);
		stepExplosionEffects(visuals, FIXED_DT);
		sampleDestructibleVisuals(destructible, visuals);
		syncCarBox();
	}

	function render() {
		applyDestructibleVisuals(visuals, 1);
		renderer.render(scene, camera);
	}
	render();

	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
	});

	window.__BARREL_DEMO__ = {
		ready: true,
		stepN: (n: number) => {
			for (let i = 0; i < n; i++) fixedStep();
			render();
		},
		crash: (speedKmh: number) => {
			crashSetup(vehicle, speedKmh);
		},
		resetWorld: () => {
			resetDestructibleWorld(destructible);
		},
		explodedCount: () => destructible.explodingBarrels.exploded.filter(Boolean).length,
	};
}

main();
