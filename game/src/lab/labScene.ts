// SPDX-License-Identifier: MIT
//
// Crash Lab's OWN minimal scene: flat pad + HDRI sky/lighting + the real car model + the pad ruler
// overlay (./grid.ts). Deliberately NOT buildScene.ts's 400m terrain/apron/forest world -- the lab is a
// standardized test pad, not the open sandbox -- but reuses every renderer-level building block
// buildScene.ts itself uses (render/environment.ts, render/sun.ts, scene/car.ts, scene/ground.ts's
// flat buildGround()) so the car/lighting look identical to the main game.

import * as THREE from 'three';
import type { QualityPreset } from '../render/quality';
import { loadEnvironment } from '../render/environment';
import { createSun } from '../render/sun';
import { buildGround } from '../scene/ground';
import { loadCar, type CarBundle } from '../scene/car';
import { CAR_MAP } from '../assets/car-map';
import { buildPadOverlay } from './grid';

export interface LabSceneBundle {
	scene: THREE.Scene;
	car: CarBundle;
	carFocus: THREE.Vector3;
	updateSunQuality: (q: QualityPreset) => void;
	rebakeEnvironment: (renderer: THREE.WebGLRenderer) => void;
	padOverlay: THREE.Group;
}

const HDRI_URL = 'assets/hdri/je_gray_02_2k.hdr';
const CAR_URL = 'assets/car/volvo-s90.glb';
const PAD_HALF_SIZE_M = 60;

export async function buildLabScene(renderer: THREE.WebGLRenderer, quality: QualityPreset): Promise<LabSceneBundle> {
	const scene = new THREE.Scene();

	const environment = await loadEnvironment(renderer, scene, HDRI_URL, quality);
	scene.fog = new THREE.Fog(0xc4ccd2, 70, 220);

	const ground = buildGround(PAD_HALF_SIZE_M * 2, Math.round((PAD_HALF_SIZE_M * 2) / 5));
	scene.add(ground.mesh);

	const padOverlay = buildPadOverlay(30, 1, 5);
	scene.add(padOverlay);

	const sunTarget = new THREE.Object3D();
	scene.add(sunTarget);
	const sun = createSun(quality, sunTarget);
	scene.add(sun.light);
	scene.add(sun.light.target);

	const car = await loadCar(CAR_URL);
	car.root.position.set(0, 0, 0);
	scene.add(car.root);

	const carFocus = new THREE.Vector3(0, CAR_MAP.overallDimsMm.height / 1000 / 2, 0);

	return {
		scene,
		car,
		carFocus,
		updateSunQuality: sun.update,
		rebakeEnvironment: environment.rebake,
		padOverlay,
	};
}
