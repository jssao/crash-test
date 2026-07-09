// SPDX-License-Identifier: MIT
//
// Keyboard input: WASD/arrows for throttle/brake/steer, space for handbrake, R to reset the car
// upright at spawn, C to toggle the chase/orbit camera. Polled once per fixed physics step (not
// event-driven for the drive axes) so input state is naturally quantized to the simulation rate.

import type { VehicleInput } from '../vehicle/vehicle';

const held = new Set<string>();
let resetRequested = false;
let cameraToggleRequested = false;

function normalizeKey(e: KeyboardEvent): string {
	return e.code;
}

export function installKeyboardInput(target: EventTarget = window): () => void {
	const onKeyDown = (e: Event) => {
		const key = normalizeKey(e as KeyboardEvent);
		held.add(key);
		if (key === 'KeyR') resetRequested = true;
		if (key === 'KeyC') cameraToggleRequested = true;
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

/** One-shot edge-triggered "was R pressed since last check" -- clears on read. */
export function consumeResetRequested(): boolean {
	if (!resetRequested) return false;
	resetRequested = false;
	return true;
}

/** One-shot edge-triggered "was C pressed since last check" -- clears on read. */
export function consumeCameraToggleRequested(): boolean {
	if (!cameraToggleRequested) return false;
	cameraToggleRequested = false;
	return true;
}
