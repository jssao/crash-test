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

/** Resonant band the scrape noise is squeezed through, swept with speed: a crawling drag sits low
 * (grindy growl), a full-speed scrape climbs toward a screech. The old fixed wide band at 2kHz
 * (Q 1.2) was effectively unshaped hiss -- read as "static", not metal on asphalt. */
export const SCRAPE_FILTER_HZ_MIN = 480;
export const SCRAPE_FILTER_HZ_MAX = 1400;
export const SCRAPE_FILTER_Q = 4;

/** 0..1 position of chassis speed within the scrape's min..full band. */
function scrapeSpeed01(speedMs: number): number {
	return clamp01((speedMs - SCRAPE_MIN_SPEED_MS) / (SCRAPE_FULL_SPEED_MS - SCRAPE_MIN_SPEED_MS));
}

/** Contact begin/end events carry no speed of their own (see events.ts's ContactEventCursor) -- while
 * a car-vs-world contact persists, the scrape loop's gain is driven by the chassis's own speed instead
 * (a reasonable proxy: a stationary/crawling scrape is quiet, a wall-scrape at speed is loud). */
export function scrapeGainFromSpeed(speedMs: number): number {
	return SCRAPE_MAX_GAIN * scrapeSpeed01(speedMs);
}

export function scrapeFilterHzFromSpeed(speedMs: number): number {
	return SCRAPE_FILTER_HZ_MIN + (SCRAPE_FILTER_HZ_MAX - SCRAPE_FILTER_HZ_MIN) * scrapeSpeed01(speedMs);
}

// ---- Skid (tire slip, read-only via vehicle/vehicle.ts's getTelemetry().slipHints) ----
/** m/s slip (Telemetry.slipHints magnitude) before the skid voice becomes audible, and the slip level
 * at which it reaches full gain. ONSET MUST SIT ABOVE THE NORMAL-DRIVING SLIP BAND: the traction
 * model deliberately allows TRACTION_SLIP_ALLOWANCE_RAD_S (10 rad/s ~= 3.9 m/s at the ~0.39m wheel)
 * of slip at FULL drive torque before it cuts anything (vehicle/tuning.ts), so ordinary throttle/
 * brake constantly produces 1-4 m/s of slip. The old 1.2 onset lived inside that band and blasted
 * the skid noise on EVERY acceleration -- the "loud static when pressing forward/back" complaint.
 * 4.0 clears the allowance band; 12 (a genuine wheelspin launch or lockup; full burnout implied by
 * TRACTION_SLIP_CUTOFF_RAD_S is ~19 m/s) reads as full-scale squeal. */
export const SKID_ONSET_SLIP_MS = 4.0;
export const SKID_FULL_SLIP_MS = 12;
export const SKID_MAX_GAIN = 0.4;
/** Hysteresis hold, seconds -- keeps a brief slip dip (a gear shift, one bumpy step) from chattering
 * the skid voice on/off every other frame. */
export const SKID_RELEASE_HOLD_S = 0.12;

export function skidGainFromSlip(absSlipMs: number): number {
	const t = clamp01((absSlipMs - SKID_ONSET_SLIP_MS) / (SKID_FULL_SLIP_MS - SKID_ONSET_SLIP_MS));
	return SKID_MAX_GAIN * t;
}

// ---- Engine hum (continuous, subtle) ----
export const ENGINE_HUM_GAIN = 0.05;
export const ENGINE_IDLE_RPM = 900;
export const ENGINE_REDLINE_RPM = 6800;
/** Fundamental = 4-cylinder 4-stroke firing frequency (rpm/30): 900rpm -> 30Hz, 6800rpm -> ~227Hz.
 * The endpoints below make the linear map below EXACTLY rpm/30 across the idle..redline span, so
 * pitch tracks revs the way a real inline-4 does instead of the old arbitrary 42..165Hz squeeze. */
export const ENGINE_HUM_HZ_AT_IDLE = ENGINE_IDLE_RPM / 30;
export const ENGINE_HUM_HZ_AT_REDLINE = ENGINE_REDLINE_RPM / 30;
/** Lowpass cutoff tracks rpm: near-closed at idle (soft chug), opens toward redline (bright snarl).
 * This timbre sweep -- not pitch alone -- is most of what reads as "revving" to the ear. */
export const ENGINE_FILTER_HZ_AT_IDLE = 320;
export const ENGINE_FILTER_HZ_AT_REDLINE = 2400;
/** Engine loudness at redline as a multiple of ENGINE_HUM_GAIN (idle loudness). */
export const ENGINE_GAIN_REDLINE_MULT = 2.4;
/** Extra short-lived loudness while rpm is RISING (throttle isn't in Telemetry, so rev rate is the
 * load proxy): full boost at/above this many rpm/s of climb, scaled linearly below it. */
export const ENGINE_REV_RATE_FULL_RPM_S = 4000;
export const ENGINE_REV_BOOST_MULT = 0.8;

/** 0..1 position of `rpm` within the idle..redline band. */
export function engineRpm01(rpm: number): number {
	return clamp01((rpm - ENGINE_IDLE_RPM) / (ENGINE_REDLINE_RPM - ENGINE_IDLE_RPM));
}

export function engineHzFromRpm(rpm: number): number {
	return ENGINE_HUM_HZ_AT_IDLE + (ENGINE_HUM_HZ_AT_REDLINE - ENGINE_HUM_HZ_AT_IDLE) * engineRpm01(rpm);
}

export function engineFilterHzFromRpm(rpm: number): number {
	return ENGINE_FILTER_HZ_AT_IDLE + (ENGINE_FILTER_HZ_AT_REDLINE - ENGINE_FILTER_HZ_AT_IDLE) * engineRpm01(rpm);
}

/** Absolute engine-hum gain from rpm + rev rate (rpm/s, positive while climbing). */
export function engineGainFromRpm(rpm: number, revRateRpmS: number): number {
	const base = ENGINE_HUM_GAIN * (1 + (ENGINE_GAIN_REDLINE_MULT - 1) * engineRpm01(rpm));
	const boost = ENGINE_HUM_GAIN * ENGINE_REV_BOOST_MULT * clamp01(revRateRpmS / ENGINE_REV_RATE_FULL_RPM_S);
	return base + boost;
}

export function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}
