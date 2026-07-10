// SPDX-License-Identifier: MIT
//
// Impact-audio material tagging convention, built on the newly-wired ShapeOptions.userMaterialId /
// HitEventCursor.userMaterialIdA/B (src/ts/shape.ts, src/ts/events.ts -- 0 means "untagged"). This
// module OWNS the numeric convention other features' shape-creation sites should adopt
// (`userMaterialId: BigInt(AUDIO_MATERIAL.xxx)`) to get material-aware impact/scrape audio instead of
// the generic DEFAULT_PROFILE fallback below.
//
// This worker (skids-audio, see STRICT OWNERSHIP) does not create any collidable shapes itself, so
// none of these ids are actually SET on any shape yet -- every hit/contact event read today arrives
// untagged (0) on both sides. Falls back to DEFAULT_PROFILE, a generic "car sheet-metal vs. hard
// surface" thud/scrape voice that stays physically reasonable regardless (one side of every car-vs-
// world hit really IS the car body, which really is sheet metal) until the vehicle/buildings/barrels/
// trees/terrain owners tag their own shapes at creation time (see this task's residuals note).
//
// No audio-file assets are used anywhere in game/src/audio -- every sound here is synthesized from
// oscillators + filtered noise (see engine.ts), keeping this repo asset-free per the task brief.

/** Numeric convention for ShapeOptions.userMaterialId (pass as BigInt(AUDIO_MATERIAL.xxx) at shape
 * creation). 0 is reserved for "untagged" (see HitEventCursor's doc comment) -- never assign 0 here. */
export const AUDIO_MATERIAL = {
	metal: 1,
	concrete: 2,
	wood: 3,
	dirt: 4,
	glass: 5,
} as const;

export type AudioMaterialName = keyof typeof AUDIO_MATERIAL;

/** One synthesized-audio "voice recipe" per surface: a body-resonance tone + how noisy vs. tonal an
 * impact reads + a separate (usually higher) scrape-loop filter center, since sustained sliding excites
 * different frequencies than a single percussive thump. Ear-tuned defaults, not measured acoustics. */
export interface ImpactProfile {
	/** Hz -- the impact voice's tonal "thump" + noise-bandpass both center around this. */
	toneHz: number;
	/** 0..1 -- how much of the impact voice is filtered noise (grit/crunch) vs. pure tone (clang/thud). */
	noiseMix: number;
	/** Percussive decay time, seconds (denser/duller materials ring shorter; hollow/resonant ones longer). */
	decayS: number;
	/** Scrape-loop bandpass center, Hz. */
	scrapeHz: number;
}

const PROFILE_BY_ID: Readonly<Record<number, ImpactProfile>> = {
	[AUDIO_MATERIAL.metal]: { toneHz: 180, noiseMix: 0.55, decayS: 0.28, scrapeHz: 2200 },
	[AUDIO_MATERIAL.concrete]: { toneHz: 110, noiseMix: 0.75, decayS: 0.22, scrapeHz: 3200 },
	[AUDIO_MATERIAL.wood]: { toneHz: 220, noiseMix: 0.4, decayS: 0.16, scrapeHz: 1400 },
	[AUDIO_MATERIAL.dirt]: { toneHz: 70, noiseMix: 0.85, decayS: 0.12, scrapeHz: 900 },
	[AUDIO_MATERIAL.glass]: { toneHz: 520, noiseMix: 0.3, decayS: 0.4, scrapeHz: 4200 },
};

/** Generic "car sheet-metal vs. hard surface" default -- see module doc for why this is always a
 * physically-reasonable fallback rather than an arbitrary guess. */
export const DEFAULT_PROFILE: ImpactProfile = { toneHz: 150, noiseMix: 0.6, decayS: 0.26, scrapeHz: 2000 };

function blend(a: ImpactProfile, b: ImpactProfile): ImpactProfile {
	return {
		toneHz: (a.toneHz + b.toneHz) / 2,
		noiseMix: (a.noiseMix + b.noiseMix) / 2,
		decayS: Math.max(a.decayS, b.decayS),
		scrapeHz: (a.scrapeHz + b.scrapeHz) / 2,
	};
}

/** Resolves the audio profile for a hit/contact pair -- prefers whichever side(s) carry a recognized
 * userMaterialId (0 = untagged, see HitEventCursor's doc comment), blending if both sides are tagged
 * with DIFFERENT materials; falls back to DEFAULT_PROFILE when neither side is tagged yet. */
export function resolveImpactProfile(userMaterialIdA: number, userMaterialIdB: number): ImpactProfile {
	const a = PROFILE_BY_ID[userMaterialIdA];
	const b = PROFILE_BY_ID[userMaterialIdB];
	if (a && b) return a === b ? a : blend(a, b);
	if (a) return a;
	if (b) return b;
	return DEFAULT_PROFILE;
}
