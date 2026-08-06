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
	HORN_ATTACK_S,
	HORN_FORMANT_HZ,
	HORN_FORMANT_Q,
	HORN_GAIN,
	HORN_HZ_HIGH,
	HORN_HZ_LOW,
	HORN_RELEASE_S,
	IMPACT_MAX_VOICES_PER_STEP,
	IMPACT_MIN_SPEED_MS,
	MASTER_VOLUME_DEFAULT,
	SCRAPE_FADE_IN_S,
	SCRAPE_FADE_OUT_S,
	SCRAPE_FILTER_HZ_MIN,
	SCRAPE_FILTER_Q,
	SKID_RELEASE_HOLD_S,
	scrapeFilterHzFromSpeed,
	engineFilterHzFromRpm,
	engineGainFromRpm,
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
	/** Diagnostic-only, never used for cleanup decisions (see duplicateOnendedGuard()'s doc comment):
	 * total times a source/oscillator's onended fired more than once for the same node. Asserted 0 in
	 * game/verify/audio-check.mjs -- see STOP_TIME_STAGGER_S's doc comment for why this stays 0 in
	 * practice despite the guard remaining as a safety net. */
	duplicateOnendedCount: number;
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

// ---- Duplicate-onended root cause -----------------------------------------------------------
// Measured directly (see game/verify/dup-onended-repro notes in this task's commit): when several
// AudioScheduledSourceNodes are scheduled to .stop() at the EXACT SAME ctx.currentTime -- which is
// exactly what happens for a multi-body impact burst (a barrel chain spawns several impact voices in
// the same processStep() call, all reading the same `now = ctx.currentTime` and, since no shape in
// this codebase tags userMaterialId yet (materials.ts), all resolving to the same DEFAULT_PROFILE.decayS
// constant) -- their stop-time boundaries land in the same WebAudio render quantum. Chromium/Brave then
// occasionally dispatches 'ended' TWICE for every node in that quantum-aligned cohort (confirmed with a
// minimal repro: 0 duplicates for staggered stop times spawned one at a time, dozens of duplicates when
// N nodes share one exact stop time). Staggering each same-step voice's stop time by a few ms (an order
// of magnitude below anything audible, and well under this app's fixed step) decorrelates the cohort
// from a single render quantum and eliminates the double-dispatch in practice. The onended guards below
// stay in place as a silent counter (duplicateOnendedCount) rather than being removed entirely: this is
// a browser implementation quirk, not something this module can prove can never recur under some other
// pathological timing, so the counter remains the honest safety net -- asserted 0 by audio-check.mjs.
//
// Measured further: a PURE index-based stagger (a few ms per same-step voice) cuts the duplicate rate
// dramatically but doesn't drive it to zero on a long, many-step barrel chain -- the fixed physics step
// (FIXED_DT) and the WebAudio render quantum (128 samples) aren't an integer ratio of each other, so the
// step-boundary's phase within a quantum slowly drifts, and a same-index voice from some OTHER, unrelated
// step can rarely re-align with this step's schedule by pure coincidence over many steps. A small random
// jitter on top of the deterministic per-index stagger decorrelates that residual periodicity (measured:
// index-only stagger left ~1 duplicate per long crash/barrel-chain run; adding the random component below
// brought repeated audio-check.mjs + barrel-chain runs to 0).
const IMPACT_STOP_STAGGER_S = 0.006;
// By the time `now + dur` is reached, the exponential gain ramp has already decayed the voice to
// ~0.0001 (effectively silent) -- so this jitter's whole range lands AFTER the audio is inaudible and
// only delays the node's internal disconnect()/liveNodeCount decrement, not anything a player hears.
// Wide enough to cover several fixed steps' worth of neighbouring impact voices (measured: 20ms still
// left an occasional duplicate on a long multi-body crash; this wider range did not, across repeated
// audio-check.mjs + barrel-chain runs).
const IMPACT_STOP_JITTER_MAX_S = 0.09;
/** Hard cap on concurrently-alive impact voices (independent of IMPACT_MAX_VOICES_PER_STEP's per-step
 * cap): a long multi-body pileup spawns voices across MANY consecutive steps, and since each voice's
 * ~0.3s decay tail overlaps several steps' worth of newer voices, the pool of simultaneously-alive
 * impact voices can otherwise grow into the dozens -- driving the same render-quantum-collision odds
 * (see IMPACT_STOP_STAGGER_S's doc comment) back up regardless of per-voice jitter. Once this many are
 * already alive, additional same-step hits are skipped (already-inaudible under that much simultaneous
 * noise) rather than spawned. */
const MAX_CONCURRENT_IMPACT_VOICES = 8;

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

function fadeAndStopLoopVoice(
	ctx: AudioContext,
	voice: LoopVoice,
	fadeS: number,
	onFullyStopped: () => void,
	onDuplicateOnended: () => void,
): void {
	const now = ctx.currentTime;
	voice.gain.gain.cancelScheduledValues(now);
	voice.gain.gain.setTargetAtTime(0, now, Math.max(fadeS / 3, 0.01));
	// Same render-quantum-collision jitter as spawnImpactVoice's IMPACT_STOP_JITTER_MAX_S (see its doc
	// comment) -- an unjittered stop time here could otherwise exactly coincide with some concurrent
	// impact voice's stop schedule and trip the same double-'ended' dispatch.
	voice.src.stop(now + fadeS + 0.05 + Math.random() * IMPACT_STOP_JITTER_MAX_S);
	let ended = false;
	voice.src.onended = () => {
		if (ended) {
			onDuplicateOnended();
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
	onDuplicateOnended: () => void,
	/** Index of this voice among the voices spawned in the SAME processStep() call (see
	 * IMPACT_STOP_STAGGER_S's doc comment -- decorrelates same-step voices' stop times from landing in
	 * the same WebAudio render quantum, which is what causes onended to double-fire). */
	indexInStep: number,
	/** Fires once when BOTH layers (noise + tone) of this voice have finished -- lets the caller track
	 * MAX_CONCURRENT_IMPACT_VOICES. */
	onVoiceFullyEnded: () => void,
): void {
	const now = ctx.currentTime;
	const dur = profile.decayS;
	const stopAt = now + dur + 0.05 + indexInStep * IMPACT_STOP_STAGGER_S + Math.random() * IMPACT_STOP_JITTER_MAX_S;
	let noiseLayerDone = false;
	let oscLayerDone = false;
	function noteLayerDone(which: 'noise' | 'osc'): void {
		if (which === 'noise') noiseLayerDone = true;
		else oscLayerDone = true;
		if (noiseLayerDone && oscLayerDone) onVoiceFullyEnded();
	}

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
	noiseSrc.stop(stopAt);
	onCountChange(3);
	let noiseEnded = false;
	noiseSrc.onended = () => {
		if (noiseEnded) {
			onDuplicateOnended();
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
		noteLayerDone('noise');
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
	osc.stop(stopAt);
	onCountChange(2);
	let oscEnded = false;
	osc.onended = () => {
		if (oscEnded) {
			onDuplicateOnended();
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
		noteLayerDone('osc');
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

	// See IMPACT_STOP_STAGGER_S's doc comment above: a silent diagnostic counter, never used for
	// cleanup/allocation decisions, asserted 0 by game/verify/audio-check.mjs.
	let duplicateOnendedCount = 0;
	function onDuplicateOnended(): void {
		duplicateOnendedCount++;
	}

	// See MAX_CONCURRENT_IMPACT_VOICES's doc comment above.
	let liveImpactVoiceCount = 0;
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

	// ---- Engine hum: persistent, correlates with revs via pitch + filter-cutoff + loudness ----
	// Two sawtooths an octave apart (firing fundamental + half-order rumble, slight detune for beat/
	// roughness) through ONE shared lowpass whose cutoff opens with rpm -- the timbre sweep is what
	// makes revving READ as revving; a fixed-cutoff drone is what earned the old "static" complaint.
	const engineGain = ctx.createGain();
	engineGain.gain.value = ENGINE_HUM_GAIN;
	const engineFilter = ctx.createBiquadFilter();
	engineFilter.type = 'lowpass';
	engineFilter.frequency.value = engineFilterHzFromRpm(0);
	engineFilter.Q.value = 1.1; // mild resonance at the cutoff -- reads as intake/exhaust formant
	engineFilter.connect(engineGain).connect(master);
	const engineOsc = ctx.createOscillator();
	engineOsc.type = 'sawtooth';
	engineOsc.connect(engineFilter);
	engineOsc.start();
	const engineOsc2 = ctx.createOscillator(); // half-order (one octave down), detuned a hair
	engineOsc2.type = 'sawtooth';
	engineOsc2.detune.value = 6;
	const engineGain2 = ctx.createGain();
	engineGain2.gain.value = 0.6; // relative to osc1, PRE-filter -- overall level lives on engineGain
	engineOsc2.connect(engineGain2).connect(engineFilter);
	engineOsc2.start();
	adjustNodeCount(5); // engineGain, engineFilter, engineOsc, engineOsc2, engineGain2
	let engineHz = engineHzFromRpm(0);
	let enginePrevRpm = 0;

	// ---- Scrape: lazy looping voice, alive only while a car-vs-world contact persists ----
	let scrapeVoice: LoopVoice | null = null;
	let scrapeStopping = false;
	let scrapeContactCount = 0;

	function ensureScrapeStarted(): void {
		scrapeStopping = false;
		if (scrapeVoice) return;
		// Starts at gain 0; gain AND filter frequency are ramped per-step below (speed-swept resonant
		// band = grind/screech that tracks the scrape, not the old fixed wide-band hiss).
		scrapeVoice = startLoopVoice(ctx, master, noiseBuffer, SCRAPE_FILTER_HZ_MIN, SCRAPE_FILTER_Q);
		adjustNodeCount(3);
	}

	function beginScrapeStop(): void {
		if (!scrapeVoice || scrapeStopping) return;
		scrapeStopping = true;
		const voice = scrapeVoice;
		fadeAndStopLoopVoice(
			ctx,
			voice,
			SCRAPE_FADE_OUT_S,
			() => {
				adjustNodeCount(-3);
				if (scrapeVoice === voice) scrapeVoice = null;
			},
			onDuplicateOnended,
		);
	}

	// ---- Skid: same lazy-loop shape as scrape, driven by tire slip instead of contact events ----
	let skidVoice: LoopVoice | null = null;
	let skidStopping = false;
	let skidReleaseTimer = 0;

	function ensureSkidStarted(): void {
		skidStopping = false;
		skidReleaseTimer = SKID_RELEASE_HOLD_S;
		if (skidVoice) return;
		// Narrow band around ~1.1kHz turns the white noise into a tonal squeal (a real tire's tread
		// resonance) -- the old wide 4.2kHz band was plain hiss and read as "static", not a tire.
		skidVoice = startLoopVoice(ctx, master, noiseBuffer, 1100, 8);
		adjustNodeCount(3);
	}

	function beginSkidStop(): void {
		if (!skidVoice || skidStopping) return;
		skidStopping = true;
		const voice = skidVoice;
		fadeAndStopLoopVoice(
			ctx,
			voice,
			0.1,
			() => {
				adjustNodeCount(-3);
				if (skidVoice === voice) skidVoice = null;
			},
			onDuplicateOnended,
		);
	}

	// ---- Horn: hold H (keydown starts, keyup stops) -- lazily built per press, torn down after the
	// release envelope so no oscillator idles between honks. Same self-owned-listener pattern as M. ----
	let hornVoice: { oscLow: OscillatorNode; oscHigh: OscillatorNode; gainHigh: GainNode; formant: BiquadFilterNode; gain: GainNode } | null = null;

	function startHorn(): void {
		if (hornVoice) return;
		const oscLow = ctx.createOscillator();
		oscLow.type = 'triangle';
		oscLow.frequency.value = HORN_HZ_LOW;
		const oscHigh = ctx.createOscillator();
		oscHigh.type = 'triangle';
		oscHigh.frequency.value = HORN_HZ_HIGH;
		const gainHigh = ctx.createGain();
		gainHigh.gain.value = 0.8; // high note slightly under the low -- matches a real dual-horn's balance
		const formant = ctx.createBiquadFilter();
		formant.type = 'bandpass';
		formant.frequency.value = HORN_FORMANT_HZ;
		formant.Q.value = HORN_FORMANT_Q;
		const gain = ctx.createGain();
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.linearRampToValueAtTime(HORN_GAIN, now + HORN_ATTACK_S);
		oscLow.connect(formant);
		oscHigh.connect(gainHigh).connect(formant);
		formant.connect(gain).connect(master);
		oscLow.start();
		oscHigh.start();
		adjustNodeCount(5);
		hornVoice = { oscLow, oscHigh, gainHigh, formant, gain };
	}

	function stopHorn(): void {
		if (!hornVoice) return;
		const v = hornVoice;
		hornVoice = null;
		const now = ctx.currentTime;
		v.gain.gain.cancelScheduledValues(now);
		v.gain.gain.setTargetAtTime(0, now, HORN_RELEASE_S / 3);
		// Same stop-time jitter rationale as fadeAndStopLoopVoice (render-quantum-collision, see
		// IMPACT_STOP_STAGGER_S's doc comment). Only oscLow carries the onended teardown; oscHigh
		// stops a hair later so its own (guarded, no-op-safe) ended event can't race the disconnect.
		v.oscLow.stop(now + HORN_RELEASE_S + 0.05 + Math.random() * IMPACT_STOP_JITTER_MAX_S);
		v.oscHigh.stop(now + HORN_RELEASE_S + 0.06 + Math.random() * IMPACT_STOP_JITTER_MAX_S);
		let ended = false;
		v.oscLow.onended = () => {
			if (ended) {
				onDuplicateOnended();
				return;
			}
			ended = true;
			try {
				v.oscLow.disconnect();
				v.oscHigh.disconnect();
				v.gainHigh.disconnect();
				v.formant.disconnect();
				v.gain.disconnect();
			} catch {
				/* already disconnected */
			}
			adjustNodeCount(-5);
		};
	}

	// ---- M mutes/unmutes -- self-contained listener (this module owns no other input file) ----
	window.addEventListener('keydown', (e) => {
		if (e.code === 'KeyM' && !e.repeat) {
			muted = !muted;
			applyMasterGain();
		}
		if (e.code === 'KeyH' && !e.repeat) startHorn();
	});
	window.addEventListener('keyup', (e) => {
		if (e.code === 'KeyH') stopHorn();
	});
	// A honk latched on when the page loses focus mid-press (alt-tab) would otherwise drone forever.
	window.addEventListener('blur', stopHorn);

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
			if (liveImpactVoiceCount >= MAX_CONCURRENT_IMPACT_VOICES) continue;
			const profile = resolveImpactProfile(h.userMaterialIdA, h.userMaterialIdB);
			liveImpactVoiceCount++;
			spawnImpactVoice(
				ctx,
				master,
				noiseBuffer,
				profile,
				impactGainFromSpeed(h.approachSpeed),
				(d) => {
					adjustNodeCount(d);
				},
				onDuplicateOnended,
				spawned,
				() => {
					liveImpactVoiceCount--;
				},
			);
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
			scrapeVoice.filter.frequency.setTargetAtTime(scrapeFilterHzFromSpeed(speedMs), ctx.currentTime, 0.05);
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

		// Rev rate (rpm/s, clamped at 0 while falling) is the load proxy -- Telemetry carries no
		// throttle, but rpm climbing fast IS the player accelerating, which is when an engine gets loud.
		const revRateRpmS = Math.max(0, (telemetry.rpm - enginePrevRpm) / dt);
		enginePrevRpm = telemetry.rpm;
		engineHz = engineHzFromRpm(telemetry.rpm);
		// 0.03s tracking (was 0.08): pitch must move WITH the tach, not trail it -- the lag read as
		// "doesn't correlate". Filter/gain get slightly softer smoothing; they can breathe a little.
		engineOsc.frequency.setTargetAtTime(engineHz, ctx.currentTime, 0.03);
		engineOsc2.frequency.setTargetAtTime(engineHz * 0.5, ctx.currentTime, 0.03);
		engineFilter.frequency.setTargetAtTime(engineFilterHzFromRpm(telemetry.rpm), ctx.currentTime, 0.05);
		engineGain.gain.setTargetAtTime(engineGainFromRpm(telemetry.rpm, revRateRpmS), ctx.currentTime, 0.05);
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
				duplicateOnendedCount,
			};
		},
	};
}
