// SPDX-License-Identifier: MIT
//
// Click-drag + wheel camera control. Left-mouse-button drag anywhere over the canvas orbits the
// camera (azimuth from horizontal drag, polar/tilt from vertical drag); the wheel zooms. Polled once
// per animation frame (poll pattern matches keyboard.ts, not event-driven per-delta) so main.ts's
// orbit controller can damp toward whatever accumulated since the last frame. Driving input (WASD) is
// untouched -- this module only ever feeds the camera.

const AZIMUTH_SENSITIVITY = 0.0055; // radians per pixel of horizontal drag
const POLAR_SENSITIVITY = 0.0045; // radians per pixel of vertical drag
const ZOOM_SENSITIVITY = 0.012; // meters per wheel deltaY unit

let dragging = false;
let lastClientX = 0;
let lastClientY = 0;
let accumAzimuth = 0;
let accumPolar = 0;
let accumZoom = 0;

/** Installs pointer(drag)+wheel listeners. `hitTarget` is the element pointerdown must land on to
 * start a drag (pass the stable #app container, not the canvas -- the canvas itself gets replaced
 * whenever render quality/antialias changes, see main.ts's createRendererOnFreshCanvas doc comment,
 * but #app never does). Move/up listen on window so a drag that leaves the element's bounds while
 * the button is still held keeps tracking. Returns a teardown function. */
export function installPointerInput(hitTarget: HTMLElement): () => void {
	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return; // left button only -- right/middle stay free for future use
		dragging = true;
		lastClientX = e.clientX;
		lastClientY = e.clientY;
	};
	const onPointerMove = (e: PointerEvent) => {
		if (!dragging) return;
		const dx = e.clientX - lastClientX;
		const dy = e.clientY - lastClientY;
		lastClientX = e.clientX;
		lastClientY = e.clientY;
		// Sign convention per user playtest feedback (2026-07-09, "inverted controls"): drag right ->
		// the camera itself swings right around the car; drag DOWN -> tilt up toward overhead
		// (grab-the-world feel). Flipped from the first-pass convention.
		accumAzimuth += dx * AZIMUTH_SENSITIVITY;
		accumPolar -= dy * POLAR_SENSITIVITY;
	};
	const onPointerUp = () => {
		dragging = false;
	};
	const onWheel = (e: WheelEvent) => {
		e.preventDefault(); // don't scroll the page while zooming the camera
		accumZoom += e.deltaY * ZOOM_SENSITIVITY;
	};

	hitTarget.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('pointermove', onPointerMove);
	window.addEventListener('pointerup', onPointerUp);
	window.addEventListener('pointercancel', onPointerUp);
	window.addEventListener('blur', onPointerUp);
	hitTarget.addEventListener('wheel', onWheel, { passive: false });

	return () => {
		hitTarget.removeEventListener('pointerdown', onPointerDown);
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerUp);
		window.removeEventListener('blur', onPointerUp);
		hitTarget.removeEventListener('wheel', onWheel);
	};
}

/** True while the left mouse button is held and dragging. */
export function isPointerDragging(): boolean {
	return dragging;
}

/** Accumulated drag deltas (radians) since the last call -- clears on read. */
export function consumeDragDelta(): { azimuth: number; polar: number } {
	const out = { azimuth: accumAzimuth, polar: accumPolar };
	accumAzimuth = 0;
	accumPolar = 0;
	return out;
}

/** Accumulated wheel-zoom delta (meters, positive = zoom out) since the last call -- clears on read. */
export function consumeZoomDelta(): number {
	const out = accumZoom;
	accumZoom = 0;
	return out;
}
