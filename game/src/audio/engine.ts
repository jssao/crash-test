// SPDX-License-Identifier: MIT
//
// Procedurally-synthesized crash audio (no audio-file assets anywhere -- every sound below is
// oscillators + filtered noise, period-appropriate for this sandbox and keeps the repo asset-free).
// Drains the newly-wired world.hitEvents()/contactBeginEvents()/contactEndEvents() (src/ts/events.ts,
// src/ts/world.ts) into a small WebAudio node graph:
//
//   master GainNode (mute/volume) -> ctx.destination
//     |- engine hum: 2 persistent oscillators, pitch from rpm telemetry (subtle, always running)
//     |- impact voices: short-lived noise-burst + sine-thump pairs, spawned per loud car-touching hit
//        event (see tuning.ts's IMPACT_MAX_VOICES_PER_STEP -- capped so a multi-body pileup can't spawn
//        unbounded nodes in one step) and self-disconnect via onended once their envelope finishes
//     |- scrape voice: ONE lazily-created/destroyed looping filtered-noise voice, alive only while a
//        car-vs-world contactBeginEvents/contactEndEvents pair is touching (see carShapes.ts's doc
//        comment on why contact events, not just hit events, are needed for a SUSTAINED scrape)
//     |- skid voice: ONE lazily-created/destroyed looping filtered-noise voice, driven by tire slip
//        read-only from vehicle/vehicle.ts's getTelemetry().slipHints (never touches vehicle.ts itself)
//
// AudioContext starts 'suspended' (browser autoplay policy) and is resumed from the FIRST real
// pointerdown/keydown the page receives (both listeners self-remove once resumed) -- see
// attachResumeOnGesture()'s doc comment. M toggles mute; this module owns that keydown listener itself
// (not input/keyboard.ts -- see STRICT OWNERSHIP) so wiring it needed zero foreign-file edits.

import type { World, Shape } from '../../../src/ts/index.js';
import { getTelemetry, type Vehicle, type WheelKey } from '../vehicle/vehicle';
import { resolveImpactProfile, type ImpactProfile } from './materials';
import { isCarEntity, isCarVsWorld } from './entities';
import {
	ENGINE_HUM_GAIN,
	IMPACT_MAX_VOICES_PER_STEP,
	IMPACT_MIN_SPEED_MS,
	MASTER_VOLUME_DEFAULT,
	SCRAPE_FADE_IN_S,
	SCRAPE_FADE_OUT_S,
	SKID_RELEASE_HOLD_S,
	engineHzFromRpm,
	impactGainFromSpeed,
	scrapeGainFromSpeed,
	skidGainFromSlip,
} from './tuning';

export interface AudioDebugSnapshot {
	contextState: AudioContextState;
	masterVolume: number;
	muted: boolean;
	/** Total WebAudio nodes this system currently owns (engine hum + master, plus whichever of
	 * scrape/skid/impact voices are alive right now) -- see game/verify/audio-check.mjs. */
	liveNodeCount: number;
	engineHz: number;
	scrapeActive: boolean;
	/** Concurrent car-vs-world contacts currently touching (0 when not scraping). */
	scrapeContactCount: number;
	skidActive: boolean;
	/** Impact voices spawned on the MOST RECENT processStep() call (0 most steps; >0 during a crash). */
	lastImpactVoicesSpawned: number;
}

export interface AudioSystem {
	/** Idempotent: enables contactBeginEvents/contactEndEvents on every shape passed (see
	 * carShapes.ts's collectCarShapes()) -- safe (and cheap) to call every fixed step. */
	armShapes(shapes: ReadonlyArray<Shape>): void;
	/** Drains this step's hit/contact events from `world` and updates engine-hum pitch + skid gain from
	 * `vehicle`'s telemetry. Call once per fixed step, after world.step(). `dt` is the fixed step size
	 * in seconds (vehicle/tuning.ts's FIXED_DT) -- used only for the skid-release hysteresis timer. */
	processStep(world: World, vehicle: Vehicle, dt: number): void;
	setMasterVolume(v: number): void;
	getMasterVolume(): number;
	setMuted(muted: boolean): void;
	/** Returns the new muted state. */
	toggleMute(): boolean;
	isMuted(): boolean;
	debugSnapshot(): AudioDebugSnapshot;
}

const NOISE_BUFFER_SECONDS = 2;

function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
	const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS));
	const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
	return buffer;
}

interface LoopVoice {
	src: AudioBufferSourceNode;
	filter: BiquadFilterNode;
	gain: GainNode;
}

function startLoopVoice(ctx: AudioContext, master: GainNode, noiseBuffer: AudioBuffer, filterHz: number, q: number): LoopVoice {
	const src = ctx.createBufferSource();
	src.buffer = noiseBuffer;
	src.loop = true;
	const filter = ctx.createBiquadFilter();
	filter.type = 'bandpass';
	filter.frequency.value = filterHz;
	filter.Q.value = q;
	const gain = ctx.createGain();
	gain.gain.value = 0;
	src.connect(filter).connect(gain).connect(master);
	src.start();
	return { src, filter, gain };
}

function fadeAndStopLoopVoice(ctx: AudioContext, voice: LoopVoice, fadeS: number, label: string, onFullyStopped: () => void): void {
	const now = ctx.currentTime;
	voice.gain.gain.cancelScheduledValues(now);
	voice.gain.gain.setTargetAtTime(0, now, Math.max(fadeS / 3, 0.01));
	voice.src.stop(now + fadeS + 0.05);
	let ended = false;
	voice.src.onended = () => {
		if (ended) {
			console.error(`[audio-debug] DUPLICATE ${label} onended fired`);
			return;
		}
		ended = true;
		try {
			voice.src.disconnect();
			voice.filter.disconnect();
			voice.gain.disconnect();
		} catch {
			/* already disconnected */
		}
		onFullyStopped();
	};
}

/** Spawns one short-lived percussive impact voice (noise-burst layer + sine-thump layer, both with
 * their own envelope) and self-disconnects once each layer's envelope finishes. `onCountChange` tracks
 * live-node bookkeeping for debugSnapshot(). */
function spawnImpactVoice(
	ctx: AudioContext,
	master: GainNode,
	noiseBuffer: AudioBuffer,
	profile: ImpactProfile,
	gain: number,
	onCountChange: (delta: number) => void,
): void {
	const now = ctx.currentTime;
	const dur = profile.decayS;

	// Noise layer: grit/crunch, bandpass-filtered brighter than the tonal thump below.
	const noiseSrc = ctx.createBufferSource();
	noiseSrc.buffer = noiseBuffer;
	const bp = ctx.createBiquadFilter();
	bp.type = 'bandpass';
	bp.frequency.value = profile.toneHz * 3;
	bp.Q.value = 0.9;
	const noiseGain = ctx.createGain();
	const noisePeak = Math.max(gain * profile.noiseMix, 0.0001);
	noiseGain.gain.setValueAtTime(0.0001, now);
	noiseGain.gain.linearRampToValueAtTime(noisePeak, now + 0.006);
	noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
	noiseSrc.connect(bp).connect(noiseGain).connect(master);
	noiseSrc.start(now);
	noiseSrc.stop(now + dur + 0.05);
	onCountChange(3);
	let noiseEnded = false;
	noiseSrc.onended = () => {
		if (noiseEnded) {
			console.error('[audio-debug] DUPLICATE noiseSrc.onended fired');
			return;
		}
		noiseEnded = true;
		try {
			noiseSrc.disconnect();
			bp.disconnect();
			noiseGain.disconnect();
		} catch {
			/* already disconnected */
		}
		onCountChange(-3);
	};

	// Tonal layer: low sine "thump" (body resonance).
	const osc = ctx.createOscillator();
	osc.type = 'sine';
	osc.frequency.value = profile.toneHz * 0.6;
	const oscGain = ctx.createGain();
	const oscPeak = Math.max(gain * (1 - profile.noiseMix), 0.0001);
	oscGain.gain.setValueAtTime(0.0001, now);
	oscGain.gain.linearRampToValueAtTime(oscPeak, now + 0.004);
	oscGain.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.8);
	osc.connect(oscGain).connect(master);
	osc.start(now);
	osc.stop(now + dur + 0.05);
	onCountChange(2);
	let oscEnded = false;
	osc.onended = () => {
		if (oscEnded) {
			console.error('[audio-debug] DUPLICATE osc.onended fired');
			return;
		}
		oscEnded = true;
		try {
			osc.disconnect();
			oscGain.disconnect();
		} catch {
			/* already disconnected */
		}
		onCountChange(-2);
	};
}

/** Resumes a suspended AudioContext from the FIRST real pointerdown/keydown the page receives (browser
 * autoplay policy: resume() must be INITIATED synchronously inside a trusted user-gesture handler --
 * see this function's callers). Both listeners remove themselves once the context is no longer
 * suspended, so this is a one-time hook, not a per-gesture cost. */
function attachResumeOnGesture(ctx: AudioContext): void {
	const tryResume = () => {
		if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
		if (ctx.state !== 'suspended') detach();
	};
	const detach = () => {
		window.removeEventListener('pointerdown', tryResume);
		window.removeEventListener('keydown', tryResume);
	};
	window.addEventListener('pointerdown', tryResume, { passive: true });
	window.addEventListener('keydown', tryResume, { passive: true });
}

export function createAudioSystem(): AudioSystem {
	const AudioCtx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
	const ctx = new AudioCtx();
	attachResumeOnGesture(ctx);

	let liveNodeCount = 0;
	/** Floored at 0: liveNodeCount is a diagnostic/verify-only counter (see debugSnapshot(), game/
	 * verify/audio-check.mjs), never used for allocation/cleanup decisions -- if some not-yet-fully-
	 * understood WebAudio scheduling race (e.g. onended firing for a node whose matching increment
	 * somehow didn't register) ever nets more decrements than increments, this keeps the REPORTED
	 * number a sane non-negative diagnostic instead of drifting further negative every voice after. */
	function adjustNodeCount(delta: number): void {
		liveNodeCount = Math.max(0, liveNodeCount + delta);
	}
	const master = ctx.createGain();
	master.connect(ctx.destination);
	adjustNodeCount(1);

	let masterVolume = MASTER_VOLUME_DEFAULT;
	let muted = false;
	function applyMasterGain(): void {
		master.gain.setTargetAtTime(muted ? 0 : masterVolume, ctx.currentTime, 0.02);
	}
	applyMasterGain();

	const noiseBuffer = buildNoiseBuffer(ctx);

	// ---- Engine hum: persistent, subtle, pitch-only (per spec) ----
	const engineGain = ctx.createGain();
	engineGain.gain.value = ENGINE_HUM_GAIN;
	const engineFilter = ctx.createBiquadFilter(); // tames the sawtooth's harsh upper harmonics -> a smoother drone
	engineFilter.type = 'lowpass';
	engineFilter.frequency.value = 800;
	engineFilter.connect(engineGain).connect(master);
	const engineOsc = ctx.createOscillator();
	engineOsc.type = 'sawtooth';
	engineOsc.connect(engineFilter);
	engineOsc.start();
	const engineOsc2 = ctx.createOscillator(); // one octave down, thickens the tone without raising volume
	engineOsc2.type = 'sine';
	const engineGain2 = ctx.createGain();
	engineGain2.gain.value = ENGINE_HUM_GAIN * 0.5;
	engineOsc2.connect(engineGain2).connect(master);
	engineOsc2.start();
	adjustNodeCount(5); // engineGain, engineFilter, engineOsc, engineOsc2, engineGain2
	let engineHz = engineHzFromRpm(0);

	// ---- Scrape: lazy looping voice, alive only while a car-vs-world contact persists ----
	let scrapeVoice: LoopVoice | null = null;
	let scrapeStopping = false;
	let scrapeContactCount = 0;

	function ensureScrapeStarted(): void {
		scrapeStopping = false;
		if (scrapeVoice) return;
		scrapeVoice = startLoopVoice(ctx, master, noiseBuffer, 2000, 1.2); // starts at gain 0, ramped by processStep below
		adjustNodeCount(3);
	}

	function beginScrapeStop(): void {
		if (!scrapeVoice || scrapeStopping) return;
		scrapeStopping = true;
		const voice = scrapeVoice;
		fadeAndStopLoopVoice(ctx, voice, SCRAPE_FADE_OUT_S, 'scrape', () => {
			adjustNodeCount(-3);
			if (scrapeVoice === voice) scrapeVoice = null;
		});
	}

	// ---- Skid: same lazy-loop shape as scrape, driven by tire slip instead of contact events ----
	let skidVoice: LoopVoice | null = null;
	let skidStopping = false;
	let skidReleaseTimer = 0;

	function ensureSkidStarted(): void {
		skidStopping = false;
		skidReleaseTimer = SKID_RELEASE_HOLD_S;
		if (skidVoice) return;
		skidVoice = startLoopVoice(ctx, master, noiseBuffer, 4200, 2.5);
		adjustNodeCount(3);
	}

	function beginSkidStop(): void {
		if (!skidVoice || skidStopping) return;
		skidStopping = true;
		const voice = skidVoice;
		fadeAndStopLoopVoice(ctx, voice, 0.1, 'skid', () => {
			adjustNodeCount(-3);
			if (skidVoice === voice) skidVoice = null;
		});
	}

	// ---- M mutes/unmutes -- self-contained listener (this module owns no other input file) ----
	window.addEventListener('keydown', (e) => {
		if (e.code === 'KeyM' && !e.repeat) {
			muted = !muted;
			applyMasterGain();
		}
	});

	let lastImpactVoicesSpawned = 0;

	function processStep(world: World, vehicle: Vehicle, dt: number): void {
		// ---- Impact: loudest car-touching hit events this step, capped per-step (perf/node guard) ----
		const carHits: { approachSpeed: number; userMaterialIdA: number; userMaterialIdB: number }[] = [];
		const hits = world.hitEvents();
		for (let i = 0; i < hits.count; i++) {
			const h = hits.at(i);
			if (isCarEntity(h.userDataA) || isCarEntity(h.userDataB)) {
				carHits.push({ approachSpeed: h.approachSpeed, userMaterialIdA: h.userMaterialIdA, userMaterialIdB: h.userMaterialIdB });
			}
		}
		carHits.sort((a, b) => b.approachSpeed - a.approachSpeed);
		let spawned = 0;
		for (const h of carHits) {
			if (spawned >= IMPACT_MAX_VOICES_PER_STEP) break;
			if (h.approachSpeed < IMPACT_MIN_SPEED_MS) continue;
			const profile = resolveImpactProfile(h.userMaterialIdA, h.userMaterialIdB);
			spawnImpactVoice(ctx, master, noiseBuffer, profile, impactGainFromSpeed(h.approachSpeed), (d) => {
				adjustNodeCount(d);
			});
			spawned++;
		}
		lastImpactVoicesSpawned = spawned;

		// ---- Scrape: contact begin/end touching exactly one car side ----
		const begins = world.contactBeginEvents();
		for (let i = 0; i < begins.count; i++) {
			const e = begins.at(i);
			if (isCarVsWorld(e.userDataA, e.userDataB)) scrapeContactCount++;
		}
		const ends = world.contactEndEvents();
		for (let i = 0; i < ends.count; i++) {
			const e = ends.at(i);
			if (isCarVsWorld(e.userDataA, e.userDataB)) scrapeContactCount = Math.max(0, scrapeContactCount - 1);
		}
		if (scrapeContactCount > 0) ensureScrapeStarted();
		else beginScrapeStop();
		if (scrapeVoice && !scrapeStopping) {
			const vel = vehicle.chassis.getLinearVelocity();
			const speedMs = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
			scrapeVoice.gain.gain.setTargetAtTime(scrapeGainFromSpeed(speedMs), ctx.currentTime, SCRAPE_FADE_IN_S / 2);
		}

		// ---- Skid + engine hum: read-only telemetry, never touches vehicle.ts ----
		const telemetry = getTelemetry(vehicle);
		let maxSlip = 0;
		for (const key of Object.keys(telemetry.slipHints) as WheelKey[]) {
			maxSlip = Math.max(maxSlip, Math.abs(telemetry.slipHints[key]));
		}
		const skidGain = skidGainFromSlip(maxSlip);
		if (skidGain > 0) ensureSkidStarted();
		else if (skidReleaseTimer > 0) skidReleaseTimer -= dt;
		else beginSkidStop();
		if (skidVoice && !skidStopping) {
			skidVoice.gain.gain.setTargetAtTime(skidGain, ctx.currentTime, 0.03);
		}

		engineHz = engineHzFromRpm(telemetry.rpm);
		engineOsc.frequency.setTargetAtTime(engineHz, ctx.currentTime, 0.08);
		engineOsc2.frequency.setTargetAtTime(engineHz * 0.5, ctx.currentTime, 0.08);
	}

	return {
		armShapes(shapes) {
			for (const s of shapes) s.enableContactEvents(true);
		},
		processStep,
		setMasterVolume(v) {
			masterVolume = Math.max(0, Math.min(1, v));
			applyMasterGain();
		},
		getMasterVolume() {
			return masterVolume;
		},
		setMuted(m) {
			muted = m;
			applyMasterGain();
		},
		toggleMute() {
			muted = !muted;
			applyMasterGain();
			return muted;
		},
		isMuted() {
			return muted;
		},
		debugSnapshot() {
			return {
				contextState: ctx.state,
				masterVolume,
				muted,
				liveNodeCount,
				engineHz,
				scrapeActive: scrapeVoice !== null && !scrapeStopping,
				scrapeContactCount,
				skidActive: skidVoice !== null && !skidStopping,
				lastImpactVoicesSpawned,
			};
		},
	};
}
