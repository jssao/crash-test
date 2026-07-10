// SPDX-License-Identifier: MIT
//
// Pure (no WebAudio/DOM) tuning constants + gain/frequency curve functions for the crash-audio layer
// (game/src/audio). Deliberately import-clean of AudioContext/OscillatorNode/etc. -- same "renderer/
// DOM-free core" split the rest of this codebase uses (e.g. vehicle/vehicle.ts vs. main.ts) -- so
// game/sim/audio-tuning.test.mjs can exercise these curves headlessly (plain node, no browser).

export const MASTER_VOLUME_DEFAULT = 0.7;

// ---- Impact (one-shot hit-event voices) ----
/** m/s. Below this, no impact voice at all -- avoids a constant flurry of near-silent taps from
 * ordinary suspension/panel jitter (src/ts/world.ts's hitEventThreshold is already 1 m/s by default;
 * this is a slightly higher audio-specific floor on top of that world-level gate). */
export const IMPACT_MIN_SPEED_MS = 1.4;
/** m/s (~80 km/h) -- approachSpeed at/above this reads as full-scale "big crash" loudness. */
export const IMPACT_FULL_SPEED_MS = 22;
export const IMPACT_MIN_GAIN = 0.08;
export const IMPACT_MAX_GAIN = 1.0;
/** Perf/node-count guard: at most this many impact voices spawned per fixed step, even if a crash
 * generates a burst of simultaneous car-touching hit events (e.g. plowing through a stacked-block
 * wall) -- the loudest approachSpeed events win (see index.ts's processStep()). */
export const IMPACT_MAX_VOICES_PER_STEP = 4;

/** 0..1 gain from approachSpeed (m/s), sqrt-shaped so quiet taps stay audible without over-compressing
 * the loud end (closer to human loudness perception than a linear ramp). Returns 0 below the min-speed
 * floor (caller should also skip spawning a voice entirely below that floor). */
export function impactGainFromSpeed(approachSpeedMs: number): number {
	const t = clamp01((approachSpeedMs - IMPACT_MIN_SPEED_MS) / (IMPACT_FULL_SPEED_MS - IMPACT_MIN_SPEED_MS));
	return IMPACT_MIN_GAIN + (IMPACT_MAX_GAIN - IMPACT_MIN_GAIN) * Math.sqrt(t);
}

// ---- Scrape (sustained car-vs-world contact loop, contactBeginEvents/contactEndEvents-driven) ----
export const SCRAPE_MIN_SPEED_MS = 0.6;
export const SCRAPE_FULL_SPEED_MS = 16;
export const SCRAPE_MAX_GAIN = 0.5;
export const SCRAPE_FADE_IN_S = 0.06;
export const SCRAPE_FADE_OUT_S = 0.18;

/** Contact begin/end events carry no speed of their own (see events.ts's ContactEventCursor) -- while
 * a car-vs-world contact persists, the scrape loop's gain is driven by the chassis's own speed instead
 * (a reasonable proxy: a stationary/crawling scrape is quiet, a wall-scrape at speed is loud). */
export function scrapeGainFromSpeed(speedMs: number): number {
	const t = clamp01((speedMs - SCRAPE_MIN_SPEED_MS) / (SCRAPE_FULL_SPEED_MS - SCRAPE_MIN_SPEED_MS));
	return SCRAPE_MAX_GAIN * t;
}

// ---- Skid (tire slip, read-only via vehicle/vehicle.ts's getTelemetry().slipHints) ----
/** m/s slip (Telemetry.slipHints magnitude) before the skid voice becomes audible, and the slip level
 * at which it reaches full gain -- well below vehicle/tuning.ts's TRACTION_SLIP_CUTOFF_RAD_S*radius,
 * so a skid is heard clearly before the traction model even caps drive torque. */
export const SKID_ONSET_SLIP_MS = 1.2;
export const SKID_FULL_SLIP_MS = 6;
export const SKID_MAX_GAIN = 0.45;
/** Hysteresis hold, seconds -- keeps a brief slip dip (a gear shift, one bumpy step) from chattering
 * the skid voice on/off every other frame. */
export const SKID_RELEASE_HOLD_S = 0.12;

export function skidGainFromSlip(absSlipMs: number): number {
	const t = clamp01((absSlipMs - SKID_ONSET_SLIP_MS) / (SKID_FULL_SLIP_MS - SKID_ONSET_SLIP_MS));
	return SKID_MAX_GAIN * t;
}

// ---- Engine hum (continuous, subtle -- pitch only, per spec) ----
export const ENGINE_HUM_GAIN = 0.05;
export const ENGINE_IDLE_RPM = 900;
export const ENGINE_REDLINE_RPM = 6800;
export const ENGINE_HUM_HZ_AT_IDLE = 42;
export const ENGINE_HUM_HZ_AT_REDLINE = 165;

export function engineHzFromRpm(rpm: number): number {
	const t = clamp01((rpm - ENGINE_IDLE_RPM) / (ENGINE_REDLINE_RPM - ENGINE_IDLE_RPM));
	return ENGINE_HUM_HZ_AT_IDLE + (ENGINE_HUM_HZ_AT_REDLINE - ENGINE_HUM_HZ_AT_IDLE) * t;
}

export function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}
