// SPDX-License-Identifier: MIT
//
// DOM overlay HUD (G4/G5 spec): big km/h + gear + thin rpm bar, a damage widget (5 panel icons + 4
// wheel dots, subscribed to the REAL damage-event emitter/telemetry -- not a mock), a controls help
// card that auto-hides on first input (re-shown with ?), an fps/physics-ms readout (F to toggle), a
// small title + collapsed credits line, and the loading-progress screen (game/index.html owns the
// loading screen's OWN markup so it paints before any JS runs -- see that file's doc comment; this
// module just drives its progress bar/hides it once assets are ready).
//
// Deliberately vanilla DOM (innerHTML template + querySelector), no framework -- this is a handful of
// read-mostly text nodes updated a few times a second, not worth a component library for.

import type { PanelKey } from '../damage/panels';
import type { DamageTelemetry } from '../damage/system';
import type { QualityLevel } from '../render/quality';
import type { Telemetry, VehicleInput, WheelKey } from '../vehicle/vehicle';

const PANEL_LABELS: Record<PanelKey, string> = {
	hood: 'Hood',
	doorL: 'Door L',
	doorR: 'Door R',
	doorRL: 'Rear Door L',
	doorRR: 'Rear Door R',
	trunk: 'Trunk',
};
// S90 swap 2026-07-11: extended with the rear doors (doorRL/doorRR) -- a plain array, NOT a
// Record<PanelKey,...>, so the compiler does NOT force this update when PanelKey gains members (see
// docs/loom/p0b-mustang-coupling.md §5's "silent trap" callout); kept in sync by hand here.
const PANEL_ORDER: readonly PanelKey[] = ['hood', 'doorL', 'doorR', 'doorRL', 'doorRR', 'trunk'];
const PANEL_ABBR: Record<PanelKey, string> = { hood: 'HD', doorL: 'DL', doorR: 'DR', doorRL: 'RL', doorRR: 'RR', trunk: 'TR' };
const WHEEL_LABELS: Record<WheelKey, string> = { fl: 'Front L', fr: 'Front R', rl: 'Rear L', rr: 'Rear R' };
const WHEEL_ORDER: readonly WheelKey[] = ['fl', 'fr', 'rl', 'rr'];

const STATE_COLOR: Record<string, string> = {
	attached: '#3ddc72',
	loosened: '#ffcc4d',
	sprung: '#ff9933',
	broken: '#ff5c5c',
	detached: '#ff5c5c',
};

const STYLE_ID = 'hud-injected-styles';

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
		.hud-panel { position: fixed; color: #e7f1ff; }
		.hud-title-block { top: 12px; left: 14px; max-width: 60vw; }
		.hud-title { font-size: 15px; font-weight: 700; letter-spacing: 0.03em; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
		.hud-credits { margin-top: 2px; font-size: 10px; color: #9db4c9; opacity: 0.85; }
		.hud-credits a { color: #9db4c9; }
		.hud-speed-cluster { left: 50%; bottom: 22px; transform: translateX(-50%); text-align: center; }
		.hud-speed-value { font-size: 56px; font-weight: 800; line-height: 1; letter-spacing: -0.01em;
			text-shadow: 0 2px 10px rgba(0,0,0,0.55); font-variant-numeric: tabular-nums; }
		.hud-speed-unit { font-size: 13px; font-weight: 600; margin-left: 6px; color: #b9cfe2; }
		.hud-gear-row { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 2px; }
		.hud-gear { font-size: 15px; font-weight: 700; background: rgba(255,255,255,0.12); border-radius: 5px; padding: 2px 9px; }
		.hud-rpm-bar { width: 220px; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.15); overflow: hidden; margin-top: 8px; }
		.hud-rpm-fill { height: 100%; width: 0%; background: linear-gradient(90deg,#3ddc72,#ffcc4d 70%,#ff5c5c); transition: width 0.08s linear; }
		.hud-damage-widget { top: 12px; right: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
			background: rgba(10,14,18,0.4); border-radius: 8px; padding: 8px 10px; backdrop-filter: blur(2px); }
		.hud-panel-row, .hud-wheel-row { display: flex; gap: 5px; }
		.hud-chip { width: 22px; height: 16px; border-radius: 3px; border: 1.5px solid rgba(255,255,255,0.55);
			display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 700; color: #06120a; }
		.hud-dot { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.55); }
		.hud-perf { top: 60px; right: 14px; font: 11px/1.4 monospace; background: rgba(10,14,18,0.5); border-radius: 6px;
			padding: 4px 8px; color: #cfe8ff; display: none; }
		.hud-perf.hud-visible { display: block; }
		.hud-help-card { left: 50%; top: 16px; transform: translateX(-50%); background: rgba(10,14,18,0.55);
			border-radius: 8px; padding: 10px 16px; font-size: 12px; line-height: 1.7; text-align: center;
			transition: opacity 0.35s ease; backdrop-filter: blur(2px); }
		.hud-help-card.hud-hidden { opacity: 0; pointer-events: none; }
		.hud-help-key { display: inline-block; min-width: 1.4em; background: rgba(255,255,255,0.14); border-radius: 4px;
			padding: 0 5px; font-weight: 700; margin-right: 5px; }
		.hud-toast { left: 50%; top: 140px; transform: translateX(-50%); background: rgba(10,14,18,0.65);
			border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
			backdrop-filter: blur(2px); opacity: 0; transition: opacity 0.25s ease; pointer-events: none;
			z-index: 10; }
		.hud-toast.hud-toast-visible { opacity: 1; }
	`;
	document.head.appendChild(style);
}

export interface HudController {
	setLoadingProgress(fraction: number, status: string): void;
	hideLoadingScreen(): void;
	updateTelemetry(t: Telemetry, cameraMode: 'chase' | 'orbit'): void;
	updateDamage(damage: DamageTelemetry): void;
	updatePerf(fps: number, physicsMs: number): void;
	setPerfVisible(visible: boolean): void;
	setQualityLevel(level: QualityLevel): void;
	/** Feed the current polled input every frame -- auto-hides the controls help card the first time
	 * any drive input is actually pressed. */
	onInput(input: VehicleInput): void;
	toggleHelpCard(): void;
	/** Briefly shows a small centered toast message (fades in, holds, fades out) -- used by main.ts's
	 * kill-plane safety net ('recovered') so an automatic recovery is visibly communicated to the
	 * player, not silent. Calling again while one is already showing restarts the hold/fade timer with
	 * the new message (never stacks multiple toasts). */
	showToast(message: string, durationMs?: number): void;
}

export function createHud(mount: HTMLElement): HudController {
	ensureStyles();

	mount.innerHTML = `
		<div class="hud-panel hud-title-block">
			<div class="hud-title">box3d crash sandbox</div>
			<div class="hud-credits">car: Volvo S90 &middot; HDRI: Poly Haven &middot;
				<a href="./CREDITS.md" target="_blank" rel="noopener">credits</a>
				&middot; quality: <span id="hud-quality-value">-</span>
				&middot; <a href="./crash-lab.html" title="Standardized NHTSA/IIHS-style crash test protocols on this car">Crash Lab</a></div>
		</div>
		<div class="hud-panel hud-speed-cluster">
			<div><span id="hud-speed-value" class="hud-speed-value">0</span><span class="hud-speed-unit">km/h</span></div>
			<div class="hud-gear-row">
				<div id="hud-gear-value" class="hud-gear">1</div>
				<div id="hud-cam-value" class="hud-gear" style="opacity:0.75">chase</div>
			</div>
			<div class="hud-rpm-bar"><div id="hud-rpm-fill" class="hud-rpm-fill"></div></div>
		</div>
		<div class="hud-panel hud-damage-widget">
			<div class="hud-panel-row" id="hud-panel-row"></div>
			<div class="hud-wheel-row" id="hud-wheel-row"></div>
		</div>
		<div class="hud-panel hud-perf" id="hud-perf"></div>
		<div class="hud-panel hud-toast" id="hud-toast"></div>
		<div class="hud-panel hud-help-card" id="hud-help-card">
			<div><span class="hud-help-key">WASD</span>drive &nbsp; <span class="hud-help-key">Space</span>handbrake</div>
			<div><span class="hud-help-key">R</span>repair car &nbsp; <span class="hud-help-key">Shift+R</span>repair + reset world</div>
			<div><span class="hud-help-key">C</span>camera &nbsp; <span class="hud-help-key">Q</span>quality &nbsp;
				<span class="hud-help-key">F</span>perf &nbsp; <span class="hud-help-key">M</span>mute &nbsp; <span class="hud-help-key">H</span>honk &nbsp; <span class="hud-help-key">?</span>this card</div>
			<div><span class="hud-help-key">Drag</span>orbit camera &nbsp; <span class="hud-help-key">Wheel</span>zoom</div>
		</div>
	`;

	const speedValueEl = mount.querySelector('#hud-speed-value')!;
	const gearValueEl = mount.querySelector('#hud-gear-value')!;
	const camValueEl = mount.querySelector('#hud-cam-value')!;
	const rpmFillEl = mount.querySelector('#hud-rpm-fill') as HTMLElement;
	const perfEl = mount.querySelector('#hud-perf') as HTMLElement;
	const helpCardEl = mount.querySelector('#hud-help-card') as HTMLElement;
	const toastEl = mount.querySelector('#hud-toast') as HTMLElement;
	const qualityValueEl = mount.querySelector('#hud-quality-value')!;
	const panelRowEl = mount.querySelector('#hud-panel-row')!;
	const wheelRowEl = mount.querySelector('#hud-wheel-row')!;

	const panelChips: Record<PanelKey, HTMLElement> = {} as Record<PanelKey, HTMLElement>;
	for (const key of PANEL_ORDER) {
		const chip = document.createElement('div');
		chip.className = 'hud-chip';
		chip.title = PANEL_LABELS[key];
		chip.textContent = PANEL_ABBR[key];
		chip.style.background = STATE_COLOR.attached;
		panelRowEl.appendChild(chip);
		panelChips[key] = chip;
	}
	const wheelDots: Record<WheelKey, HTMLElement> = {} as Record<WheelKey, HTMLElement>;
	for (const key of WHEEL_ORDER) {
		const dot = document.createElement('div');
		dot.className = 'hud-dot';
		dot.title = WHEEL_LABELS[key];
		dot.style.background = STATE_COLOR.attached;
		wheelRowEl.appendChild(dot);
		wheelDots[key] = dot;
	}

	const loadingEl = document.getElementById('hud-loading');
	const loadingFillEl = document.getElementById('hud-loading-fill');
	const loadingStatusEl = document.getElementById('hud-loading-status');

	let helpVisible = true;
	let hasSeenInput = false;
	let toastHideTimer: ReturnType<typeof setTimeout> | null = null;

	function setHelpVisible(visible: boolean): void {
		helpVisible = visible;
		helpCardEl.classList.toggle('hud-hidden', !visible);
	}

	return {
		setLoadingProgress(fraction, status) {
			if (loadingFillEl) loadingFillEl.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
			if (loadingStatusEl) loadingStatusEl.textContent = status;
		},
		hideLoadingScreen() {
			loadingEl?.classList.add('hud-loading-hidden');
			setTimeout(() => loadingEl?.remove(), 500);
		},
		updateTelemetry(t, cameraMode) {
			speedValueEl.textContent = t.speedKmh.toFixed(0);
			gearValueEl.textContent = t.gear <= 0 ? 'R' : String(t.gear);
			camValueEl.textContent = cameraMode;
			const rpmFrac = Math.max(0, Math.min(1, t.rpm / 6800));
			rpmFillEl.style.width = `${(rpmFrac * 100).toFixed(1)}%`;
		},
		updateDamage(damage) {
			for (const key of PANEL_ORDER) {
				panelChips[key].style.background = STATE_COLOR[damage.panelStates[key]] ?? STATE_COLOR.attached;
			}
			for (const key of WHEEL_ORDER) {
				wheelDots[key].style.background = STATE_COLOR[damage.wheelStates[key]] ?? STATE_COLOR.attached;
			}
		},
		updatePerf(fps, physicsMs) {
			perfEl.textContent = `fps ${fps.toFixed(0)}  |  physics ${physicsMs.toFixed(2)}ms`;
		},
		setPerfVisible(visible) {
			perfEl.classList.toggle('hud-visible', visible);
		},
		setQualityLevel(level) {
			qualityValueEl.textContent = level;
		},
		onInput(input) {
			if (hasSeenInput) return;
			if (input.throttle > 0 || input.brake > 0 || input.steer !== 0 || input.handbrake) {
				hasSeenInput = true;
				setHelpVisible(false);
			}
		},
		toggleHelpCard() {
			setHelpVisible(!helpVisible);
		},
		showToast(message, durationMs = 2200) {
			toastEl.textContent = message;
			toastEl.classList.add('hud-toast-visible');
			if (toastHideTimer !== null) clearTimeout(toastHideTimer);
			toastHideTimer = setTimeout(() => {
				toastEl.classList.remove('hud-toast-visible');
				toastHideTimer = null;
			}, durationMs);
		},
	};
}
