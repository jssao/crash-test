// SPDX-License-Identifier: MIT
//
// Keyboard input: WASD/arrows for throttle/brake/steer, space for handbrake, R to fully repair+
// respawn the car, Shift+R to also restore the destructible world, C to toggle the chase/orbit
// camera, Q to cycle render-quality presets, F to toggle the fps/physics-ms readout, ? to re-show the
// controls help card. Polled once per fixed physics step (not event-driven for the drive axes) so
// input state is naturally quantized to the simulation rate.

import type { VehicleInput } from '../vehicle/vehicle';

const held = new Set<string>();
let carResetRequested = false;
let worldResetRequested = false;
let cameraToggleRequested = false;
let qualityCycleRequested = false;
let fpsToggleRequested = false;
let helpToggleRequested = false;

function normalizeKey(e: KeyboardEvent): string {
	return e.code;
}

export function installKeyboardInput(target: EventTarget = window): () => void {
	const onKeyDown = (e: Event) => {
		const ke = e as KeyboardEvent;
		const key = normalizeKey(ke);
		held.add(key);
		if (key === 'KeyR') {
			if (ke.shiftKey) worldResetRequested = true;
			else carResetRequested = true;
		}
		if (key === 'KeyC') cameraToggleRequested = true;
		if (key === 'KeyQ') qualityCycleRequested = true;
		if (key === 'KeyF') fpsToggleRequested = true;
		if (ke.key === '?') helpToggleRequested = true;
		if (key === 'Space') e.preventDefault(); // avoid scrolling the page
	};
	const onKeyUp = (e: Event) => held.delete(normalizeKey(e as KeyboardEvent));
	const onBlur = () => held.clear();

	target.addEventListener('keydown', onKeyDown);
	target.addEventListener('keyup', onKeyUp);
	window.addEventListener('blur', onBlur);

	return () => {
		target.removeEventListener('keydown', onKeyDown);
		target.removeEventListener('keyup', onKeyUp);
		window.removeEventListener('blur', onBlur);
	};
}

/** Current drive input from held keys. Pure poll -- safe to call every fixed step. */
export function readKeyboardInput(): VehicleInput {
	const throttle = held.has('KeyW') || held.has('ArrowUp') ? 1 : 0;
	const brake = held.has('KeyS') || held.has('ArrowDown') ? 1 : 0;
	const steerLeft = held.has('KeyA') || held.has('ArrowLeft');
	const steerRight = held.has('KeyD') || held.has('ArrowRight');
	const steer = (steerRight ? 1 : 0) - (steerLeft ? 1 : 0);
	const handbrake = held.has('Space');
	return { throttle, brake, steer, handbrake };
}

/** One-shot edge-triggered "was R (without Shift) pressed since last check" -- clears on read. */
export function consumeCarResetRequested(): boolean {
	if (!carResetRequested) return false;
	carResetRequested = false;
	return true;
}

/** One-shot edge-triggered "was Shift+R pressed since last check" -- clears on read. */
export function consumeWorldResetRequested(): boolean {
	if (!worldResetRequested) return false;
	worldResetRequested = false;
	return true;
}

/** One-shot edge-triggered "was C pressed since last check" -- clears on read. */
export function consumeCameraToggleRequested(): boolean {
	if (!cameraToggleRequested) return false;
	cameraToggleRequested = false;
	return true;
}

/** One-shot edge-triggered "was Q pressed since last check" -- clears on read. */
export function consumeQualityCycleRequested(): boolean {
	if (!qualityCycleRequested) return false;
	qualityCycleRequested = false;
	return true;
}

/** One-shot edge-triggered "was F pressed since last check" -- clears on read. */
export function consumeFpsToggleRequested(): boolean {
	if (!fpsToggleRequested) return false;
	fpsToggleRequested = false;
	return true;
}

/** One-shot edge-triggered "was ? pressed since last check" -- clears on read. */
export function consumeHelpToggleRequested(): boolean {
	if (!helpToggleRequested) return false;
	helpToggleRequested = false;
	return true;
}
