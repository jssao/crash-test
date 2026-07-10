// SPDX-License-Identifier: MIT
//
// Headless (no AudioContext/DOM) regression tests for the crash-audio layer's PURE decision logic --
// materials.ts's profile resolution, tuning.ts's gain/frequency curves, and entities.ts's car-vs-world
// classification. Deliberately does NOT import engine.ts (the actual WebAudio node graph) -- that half
// only runs in a real browser and is covered by game/verify/audio-check.mjs instead. Same "renderer/
// DOM-free core has its own headless tests" split the rest of game/sim/*.test.mjs already uses.
import { describe, expect, it } from 'vitest';
import {
	AUDIO_MATERIAL,
	DEFAULT_PROFILE,
	resolveImpactProfile,
} from '../src/audio/materials.ts';
import {
	IMPACT_FULL_SPEED_MS,
	IMPACT_MAX_GAIN,
	IMPACT_MIN_GAIN,
	IMPACT_MIN_SPEED_MS,
	SCRAPE_FULL_SPEED_MS,
	SCRAPE_MAX_GAIN,
	SCRAPE_MIN_SPEED_MS,
	SKID_FULL_SLIP_MS,
	SKID_MAX_GAIN,
	SKID_ONSET_SLIP_MS,
	ENGINE_HUM_HZ_AT_IDLE,
	ENGINE_HUM_HZ_AT_REDLINE,
	ENGINE_IDLE_RPM,
	ENGINE_REDLINE_RPM,
	engineHzFromRpm,
	impactGainFromSpeed,
	scrapeGainFromSpeed,
	skidGainFromSlip,
} from '../src/audio/tuning.ts';
import { CAR_PART_ENTITY_IDS, isCarEntity, isCarVsWorld } from '../src/audio/entities.ts';
import { CAR_ENTITY_ID } from '../src/vehicle/vehicle.ts';
import { PANEL_ENTITY_ID } from '../src/damage/panels.ts';

describe('audio materials: resolveImpactProfile', () => {
	it('falls back to DEFAULT_PROFILE when neither side is tagged (untagged = 0)', () => {
		expect(resolveImpactProfile(0, 0)).toEqual(DEFAULT_PROFILE);
	});

	it('uses the tagged side\'s profile when only one side carries a recognized userMaterialId', () => {
		const wood = resolveImpactProfile(AUDIO_MATERIAL.wood, 0);
		expect(wood.toneHz).toBe(220);
		const woodOtherSide = resolveImpactProfile(0, AUDIO_MATERIAL.wood);
		expect(woodOtherSide).toEqual(wood);
	});

	it('returns the SAME profile object (no pointless blend) when both sides share one material id', () => {
		const metal = resolveImpactProfile(AUDIO_MATERIAL.metal, AUDIO_MATERIAL.metal);
		expect(metal.toneHz).toBe(180);
	});

	it('blends two DIFFERENT tagged materials (result sits between the two tone/scrape frequencies)', () => {
		const blended = resolveImpactProfile(AUDIO_MATERIAL.metal, AUDIO_MATERIAL.concrete);
		expect(blended.toneHz).toBeGreaterThan(Math.min(180, 110));
		expect(blended.toneHz).toBeLessThan(Math.max(180, 110));
		expect(blended.toneHz).toBeCloseTo((180 + 110) / 2, 5);
	});
});

describe('audio tuning: gain/frequency curves', () => {
	it('impactGainFromSpeed: floors at IMPACT_MIN_GAIN at/below the min-speed floor, caps at IMPACT_MAX_GAIN at/above full speed', () => {
		expect(impactGainFromSpeed(IMPACT_MIN_SPEED_MS)).toBeCloseTo(IMPACT_MIN_GAIN, 6);
		expect(impactGainFromSpeed(IMPACT_FULL_SPEED_MS)).toBeCloseTo(IMPACT_MAX_GAIN, 6);
		expect(impactGainFromSpeed(IMPACT_FULL_SPEED_MS + 50)).toBeCloseTo(IMPACT_MAX_GAIN, 6); // clamps, doesn't overshoot
	});

	it('impactGainFromSpeed is monotonically non-decreasing with approach speed', () => {
		let prev = -Infinity;
		for (let v = 0; v <= IMPACT_FULL_SPEED_MS + 10; v += 1) {
			const g = impactGainFromSpeed(v);
			expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = g;
		}
	});

	it('scrapeGainFromSpeed: silent at/below the min speed, full SCRAPE_MAX_GAIN at/above full speed', () => {
		expect(scrapeGainFromSpeed(SCRAPE_MIN_SPEED_MS)).toBeCloseTo(0, 6);
		expect(scrapeGainFromSpeed(0)).toBeCloseTo(0, 6);
		expect(scrapeGainFromSpeed(SCRAPE_FULL_SPEED_MS)).toBeCloseTo(SCRAPE_MAX_GAIN, 6);
		expect(scrapeGainFromSpeed(SCRAPE_FULL_SPEED_MS + 20)).toBeCloseTo(SCRAPE_MAX_GAIN, 6);
	});

	it('skidGainFromSlip: silent at/below onset slip, full SKID_MAX_GAIN at/above full slip', () => {
		expect(skidGainFromSlip(SKID_ONSET_SLIP_MS)).toBeCloseTo(0, 6);
		expect(skidGainFromSlip(0)).toBeCloseTo(0, 6);
		expect(skidGainFromSlip(SKID_FULL_SLIP_MS)).toBeCloseTo(SKID_MAX_GAIN, 6);
	});

	it('engineHzFromRpm: idle -> ENGINE_HUM_HZ_AT_IDLE, redline -> ENGINE_HUM_HZ_AT_REDLINE, monotonic between', () => {
		expect(engineHzFromRpm(ENGINE_IDLE_RPM)).toBeCloseTo(ENGINE_HUM_HZ_AT_IDLE, 6);
		expect(engineHzFromRpm(ENGINE_REDLINE_RPM)).toBeCloseTo(ENGINE_HUM_HZ_AT_REDLINE, 6);
		expect(engineHzFromRpm((ENGINE_IDLE_RPM + ENGINE_REDLINE_RPM) / 2)).toBeGreaterThan(ENGINE_HUM_HZ_AT_IDLE);
		expect(engineHzFromRpm((ENGINE_IDLE_RPM + ENGINE_REDLINE_RPM) / 2)).toBeLessThan(ENGINE_HUM_HZ_AT_REDLINE);
	});
});

describe('audio entities: car-vs-world classification', () => {
	it('recognizes chassis, every wheel, and every damage panel as car entities', () => {
		expect(isCarEntity(CAR_ENTITY_ID.chassis)).toBe(true);
		for (const id of Object.values(CAR_ENTITY_ID.wheel)) expect(isCarEntity(id)).toBe(true);
		for (const id of Object.values(PANEL_ENTITY_ID)) expect(isCarEntity(id)).toBe(true);
		expect(CAR_PART_ENTITY_IDS.size).toBe(1 + Object.keys(CAR_ENTITY_ID.wheel).length + Object.keys(PANEL_ENTITY_ID).length);
	});

	it('does not classify an arbitrary world-body id as a car entity', () => {
		expect(isCarEntity(9999)).toBe(false);
	});

	it('isCarVsWorld: true for car-vs-unknown, false for car-vs-car (self-contact) and world-vs-world', () => {
		expect(isCarVsWorld(CAR_ENTITY_ID.chassis, 500)).toBe(true);
		expect(isCarVsWorld(500, CAR_ENTITY_ID.chassis)).toBe(true);
		expect(isCarVsWorld(CAR_ENTITY_ID.chassis, CAR_ENTITY_ID.wheel.fl)).toBe(false);
		expect(isCarVsWorld(500, 501)).toBe(false);
	});
});
