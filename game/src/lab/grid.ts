// SPDX-License-Identifier: MIT
//
// Pad ruler/grid overlay: a metric grid on the ground plane plus small labeled distance markers along
// the forward/rear and left/right axes, so a screenshot (or a live view) reads crush/travel distance
// visually against a known scale. Pure three.js, no physics.

import * as THREE from 'three';

function makeLabelSprite(text: string): THREE.Sprite {
	const canvas = document.createElement('canvas');
	canvas.width = 128;
	canvas.height = 64;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'rgba(10,14,18,0.55)';
	ctx.fillRect(0, 0, 128, 64);
	ctx.font = 'bold 28px monospace';
	ctx.fillStyle = '#cfe8ff';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 64, 32);
	const tex = new THREE.CanvasTexture(canvas);
	tex.needsUpdate = true;
	const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
	const sprite = new THREE.Sprite(mat);
	sprite.scale.set(1.1, 0.55, 1);
	sprite.renderOrder = 10;
	return sprite;
}

/**
 * Builds a `halfSize`x`halfSize`(m) grid (minor lines every `step`m, brighter major lines every
 * `majorStep`m) centered on the world origin (the vehicle's spawn point), plus "Nm" labels along both
 * the +/-Z (front/rear) and +/-X (left/right) axes at every major line -- lets a screenshot be read
 * against a known scale without needing to eyeball the car's own length.
 */
export function buildPadOverlay(halfSize = 30, step = 1, majorStep = 5): THREE.Group {
	const group = new THREE.Group();
	group.name = 'LabPadOverlay';

	const minorPts: number[] = [];
	const majorPts: number[] = [];
	const y = 0.012; // just above the ground plane -- avoids z-fighting
	for (let x = -halfSize; x <= halfSize + 1e-6; x += step) {
		const isMajor = Math.abs(Math.round(x / majorStep) * majorStep - x) < 1e-6;
		(isMajor ? majorPts : minorPts).push(x, y, -halfSize, x, y, halfSize);
	}
	for (let z = -halfSize; z <= halfSize + 1e-6; z += step) {
		const isMajor = Math.abs(Math.round(z / majorStep) * majorStep - z) < 1e-6;
		(isMajor ? majorPts : minorPts).push(-halfSize, y, z, halfSize, y, z);
	}

	const minorGeom = new THREE.BufferGeometry();
	minorGeom.setAttribute('position', new THREE.Float32BufferAttribute(minorPts, 3));
	const minorMat = new THREE.LineBasicMaterial({ color: 0x33445a, transparent: true, opacity: 0.3 });
	group.add(new THREE.LineSegments(minorGeom, minorMat));

	const majorGeom = new THREE.BufferGeometry();
	majorGeom.setAttribute('position', new THREE.Float32BufferAttribute(majorPts, 3));
	const majorMat = new THREE.LineBasicMaterial({ color: 0x6fa8dc, transparent: true, opacity: 0.5 });
	group.add(new THREE.LineSegments(majorGeom, majorMat));

	for (let d = majorStep; d <= halfSize; d += majorStep) {
		const zPlus = makeLabelSprite(`${d}m`);
		zPlus.position.set(0.5, 0.4, d);
		group.add(zPlus);
		const zMinus = makeLabelSprite(`${d}m`);
		zMinus.position.set(0.5, 0.4, -d);
		group.add(zMinus);
		const xPlus = makeLabelSprite(`${d}m`);
		xPlus.position.set(d, 0.4, 0.5);
		group.add(xPlus);
		const xMinus = makeLabelSprite(`${d}m`);
		xMinus.position.set(-d, 0.4, 0.5);
		group.add(xMinus);
	}

	return group;
}
