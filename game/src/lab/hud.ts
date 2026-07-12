// SPDX-License-Identifier: MIT
//
// Crash Lab DOM overlay: protocol picker, free-config sliders, run/reset/slow-mo/export controls,
// camera presets, and the live instrumentation readout panel. Vanilla DOM (innerHTML template +
// querySelector), same convention as game/src/hud/hud.ts -- a separate module (not a shared import)
// since the two pages' controls have almost nothing in common (driving HUD vs. lab instrumentation).

import type { PanelKey } from '../damage/panels';
import type { WheelKey } from '../vehicle/vehicle';
import type { CrushMeasurement, OccupantSummary } from './instrumentation';
import { FREE_CONFIG_ANGLE_RANGE, FREE_CONFIG_OFFSET_RANGE, FREE_CONFIG_SPEED_RANGE, type CrashProtocol, type CrushRegion, type FreeConfigState } from './protocols';

export type CameraPreset = 'top' | 'side' | '3q' | 'free';
export type RunState = 'idle' | 'running' | 'settled';

// S90 swap 2026-07-11: extended with the rear doors (doorRL/doorRR) -- a plain array, NOT a
// Record<PanelKey,...>, so the compiler does NOT force this update when PanelKey gains members (see
// docs/loom/p0b-mustang-coupling.md §5's "silent trap" callout); kept in sync by hand here (same fix
// applied to src/hud/hud.ts's own duplicate PANEL_ORDER).
const PANEL_ORDER: readonly PanelKey[] = ['hood', 'doorL', 'doorR', 'doorRL', 'doorRR', 'trunk'];
const PANEL_LABELS: Record<PanelKey, string> = {
	hood: 'Hood',
	doorL: 'Door L',
	doorR: 'Door R',
	doorRL: 'Rear Door L',
	doorRR: 'Rear Door R',
	trunk: 'Trunk',
};
const WHEEL_ORDER: readonly WheelKey[] = ['fl', 'fr', 'rl', 'rr'];
const WHEEL_LABELS: Record<WheelKey, string> = { fl: 'FL', fr: 'FR', rl: 'RL', rr: 'RR' };
const REGION_ORDER: readonly CrushRegion[] = ['front', 'left', 'right', 'rear'];
const REGION_LABELS: Record<CrushRegion, string> = { front: 'Front', left: 'Left', right: 'Right', rear: 'Rear' };
const STATE_COLOR: Record<string, string> = { attached: '#3ddc72', loosened: '#ffcc4d', broken: '#ff5c5c', detached: '#ff5c5c' };

export interface ReadoutData {
	crush: Record<CrushRegion, CrushMeasurement>;
	/** Crush M2 (vehicle/segments.ts telemetry): MECHANICAL front/rear structural shortening (m) --
	 * the collision-carrying rest-pose truth, vs the cosmetic mesh depths above. */
	mechCrushFrontM: number;
	mechCrushRearM: number;
	/** Crush M2: NHTSA-style intrusion (m) -- the engine cradle's permanent shift toward the
	 * firewall (occupant leg-injury line ~0.15m). */
	intrusionM: number;
	panelStates: Record<PanelKey, string>;
	wheelStates: Record<WheelKey, string>;
	dentedVertexCount: number;
	chassisPeakDecelG: number;
	occupants: OccupantSummary[];
}

export interface LabHudCallbacks {
	onSelectProtocol: (id: string) => void;
	onRun: () => void;
	onReset: () => void;
	onToggleSlowMo: () => void;
	onToggleBarrier: () => void;
	onExport: () => void;
	onCameraPreset: (preset: CameraPreset) => void;
	onFreeConfigChange: (next: Partial<FreeConfigState>) => void;
}

export interface LabHudController {
	setLoadingProgress(fraction: number, status: string): void;
	hideLoadingScreen(): void;
	setProtocols(protocols: readonly CrashProtocol[], activeId: string): void;
	setFreeConfigVisible(visible: boolean): void;
	setFreeConfigValues(state: FreeConfigState): void;
	setRunState(state: RunState, elapsedS: number, totalS: number): void;
	setSlowMo(enabled: boolean): void;
	setBarrierHidden(hidden: boolean): void;
	setCameraPreset(preset: CameraPreset): void;
	updateReadout(data: ReadoutData): void;
	showToast(message: string): void;
}

const STYLE_ID = 'lab-hud-injected-styles';

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
		.lab-panel { position: fixed; color: #e7f1ff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
		.lab-title-block { top: 12px; left: 14px; pointer-events: auto; }
		.lab-title { font-size: 15px; font-weight: 700; letter-spacing: 0.03em; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
		.lab-back-link { margin-top: 3px; font-size: 11px; }
		.lab-back-link a { color: #9db4c9; }
		.lab-sidebar { top: 60px; left: 14px; width: 250px; max-height: calc(100vh - 90px); overflow-y: auto;
			background: rgba(10,14,18,0.55); border-radius: 10px; padding: 10px; backdrop-filter: blur(3px); pointer-events: auto; }
		.lab-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #8fa6bd; margin: 10px 0 5px; }
		.lab-section-label:first-child { margin-top: 0; }
		.lab-protocol-btn { display: block; width: 100%; text-align: left; background: rgba(255,255,255,0.06); border: 1px solid transparent;
			color: #e7f1ff; border-radius: 6px; padding: 6px 8px; margin-bottom: 4px; font-size: 12px; cursor: pointer; }
		.lab-protocol-btn:hover { background: rgba(255,255,255,0.12); }
		.lab-protocol-btn.lab-active { border-color: #4fa8ff; background: rgba(79,168,255,0.18); }
		.lab-protocol-summary { font-size: 10px; color: #9db4c9; margin-top: 6px; line-height: 1.4; }
		.lab-slider-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; }
		.lab-slider-row label { width: 46px; flex-shrink: 0; color: #9db4c9; }
		.lab-slider-row input[type=range] { flex: 1; }
		.lab-slider-row .lab-slider-val { width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
		.lab-btn-row { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
		.lab-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15); color: #e7f1ff;
			border-radius: 6px; padding: 6px 10px; font-size: 11px; cursor: pointer; }
		.lab-btn:hover { background: rgba(255,255,255,0.18); }
		.lab-btn.lab-active { background: #2f7dd6; border-color: #4fa8ff; }
		.lab-btn.lab-primary { background: #2f9e52; border-color: #3ddc72; }
		.lab-btn.lab-primary:hover { background: #37b45f; }
		.lab-btn:disabled { opacity: 0.4; cursor: default; }
		.lab-readout { top: 60px; right: 14px; width: 260px; background: rgba(10,14,18,0.55); border-radius: 10px;
			padding: 10px; backdrop-filter: blur(3px); font-size: 11px; }
		.lab-run-state { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
		.lab-run-state.lab-idle { color: #9db4c9; }
		.lab-run-state.lab-running { color: #ffcc4d; }
		.lab-run-state.lab-settled { color: #3ddc72; }
		.lab-metric-row { display: flex; justify-content: space-between; padding: 2px 0; }
		.lab-metric-row span:last-child { font-variant-numeric: tabular-nums; }
		.lab-chip-row { display: flex; gap: 4px; margin: 4px 0; flex-wrap: wrap; }
		.lab-chip { font-size: 9px; font-weight: 700; color: #06120a; border-radius: 4px; padding: 2px 5px; }
		.lab-occupant-row { display: flex; justify-content: space-between; font-size: 10px; padding: 2px 0; border-top: 1px solid rgba(255,255,255,0.08); }
		.lab-occupant-row:first-of-type { border-top: none; }
		.lab-dead { color: #ff5c5c; }
		.lab-alive { color: #3ddc72; }
		.lab-toast { left: 50%; top: 16px; transform: translateX(-50%); background: rgba(10,14,18,0.7);
			border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 600; opacity: 0; transition: opacity 0.25s ease;
			pointer-events: none; z-index: 10; }
		.lab-toast.lab-toast-visible { opacity: 1; }
	`;
	document.head.appendChild(style);
}

export function createLabHud(mount: HTMLElement, callbacks: LabHudCallbacks): LabHudController {
	ensureStyles();

	mount.innerHTML = `
		<div class="lab-panel lab-title-block">
			<div class="lab-title">Crash Lab</div>
			<div class="lab-back-link"><a href="./index.html">&larr; back to the game</a></div>
		</div>
		<div class="lab-panel lab-sidebar" id="lab-sidebar">
			<div class="lab-section-label">Protocol</div>
			<div id="lab-protocol-list"></div>
			<div class="lab-protocol-summary" id="lab-protocol-summary"></div>
			<div id="lab-freeconfig" style="display:none">
				<div class="lab-section-label">Free configuration</div>
				<div class="lab-slider-row"><label>Speed</label><input type="range" id="lab-fc-speed" min="${FREE_CONFIG_SPEED_RANGE[0]}" max="${FREE_CONFIG_SPEED_RANGE[1]}" step="1" /><span class="lab-slider-val" id="lab-fc-speed-val"></span></div>
				<div class="lab-slider-row"><label>Offset</label><input type="range" id="lab-fc-offset" min="${FREE_CONFIG_OFFSET_RANGE[0]}" max="${FREE_CONFIG_OFFSET_RANGE[1]}" step="0.05" /><span class="lab-slider-val" id="lab-fc-offset-val"></span></div>
				<div class="lab-slider-row"><label>Angle</label><input type="range" id="lab-fc-angle" min="${FREE_CONFIG_ANGLE_RANGE[0]}" max="${FREE_CONFIG_ANGLE_RANGE[1]}" step="1" /><span class="lab-slider-val" id="lab-fc-angle-val"></span></div>
			</div>
			<div class="lab-section-label">Run</div>
			<div class="lab-btn-row">
				<button class="lab-btn lab-primary" id="lab-btn-run">Run</button>
				<button class="lab-btn" id="lab-btn-reset">Reset</button>
				<button class="lab-btn" id="lab-btn-slowmo">0.25&times; slow-mo</button>
				<button class="lab-btn" id="lab-btn-export">Export report</button>
			</div>
			<div class="lab-section-label">Camera</div>
			<div class="lab-btn-row">
				<button class="lab-btn" id="lab-cam-top">Top</button>
				<button class="lab-btn" id="lab-cam-side">Side</button>
				<button class="lab-btn" id="lab-cam-3q">3/4</button>
				<button class="lab-btn" id="lab-cam-free">Free orbit</button>
				<button class="lab-btn" id="lab-btn-barrier" title="Hide the barrier to inspect the crushed face">Hide barrier</button>
			</div>
		</div>
		<div class="lab-panel lab-readout" id="lab-readout">
			<div class="lab-run-state lab-idle" id="lab-run-state">IDLE</div>
			<div class="lab-section-label">Crush depth (m)</div>
			<div id="lab-crush-rows"></div>
			<div class="lab-section-label">Panels</div>
			<div class="lab-chip-row" id="lab-panel-chips"></div>
			<div class="lab-section-label">Wheels</div>
			<div class="lab-chip-row" id="lab-wheel-chips"></div>
			<div class="lab-section-label">Structural (mechanical)</div>
			<div class="lab-metric-row"><span>Mech crush F / R</span><span id="lab-mech-crush">0.000 / 0.000</span></div>
			<div class="lab-metric-row"><span>Intrusion (firewall)</span><span id="lab-intrusion">0.000</span></div>
			<div class="lab-metric-row"><span>Dented vertices</span><span id="lab-dented">0</span></div>
			<div class="lab-metric-row"><span>Chassis peak decel</span><span id="lab-decel">0.0 g</span></div>
			<div class="lab-section-label">Occupants</div>
			<div id="lab-occupants"></div>
		</div>
		<div class="lab-panel lab-toast" id="lab-toast"></div>
	`;

	const protocolListEl = mount.querySelector('#lab-protocol-list')!;
	const protocolSummaryEl = mount.querySelector('#lab-protocol-summary')!;
	const freeConfigEl = mount.querySelector('#lab-freeconfig') as HTMLElement;
	const fcSpeed = mount.querySelector('#lab-fc-speed') as HTMLInputElement;
	const fcOffset = mount.querySelector('#lab-fc-offset') as HTMLInputElement;
	const fcAngle = mount.querySelector('#lab-fc-angle') as HTMLInputElement;
	const fcSpeedVal = mount.querySelector('#lab-fc-speed-val')!;
	const fcOffsetVal = mount.querySelector('#lab-fc-offset-val')!;
	const fcAngleVal = mount.querySelector('#lab-fc-angle-val')!;
	const runStateEl = mount.querySelector('#lab-run-state') as HTMLElement;
	const crushRowsEl = mount.querySelector('#lab-crush-rows')!;
	const panelChipsEl = mount.querySelector('#lab-panel-chips')!;
	const wheelChipsEl = mount.querySelector('#lab-wheel-chips')!;
	const mechCrushEl = mount.querySelector('#lab-mech-crush')!;
	const intrusionEl = mount.querySelector('#lab-intrusion')!;
	const dentedEl = mount.querySelector('#lab-dented')!;
	const decelEl = mount.querySelector('#lab-decel')!;
	const occupantsEl = mount.querySelector('#lab-occupants')!;
	const toastEl = mount.querySelector('#lab-toast') as HTMLElement;
	const slowMoBtn = mount.querySelector('#lab-btn-slowmo') as HTMLButtonElement;
	const barrierBtn = mount.querySelector('#lab-btn-barrier') as HTMLButtonElement;
	const camBtns: Record<CameraPreset, HTMLButtonElement> = {
		top: mount.querySelector('#lab-cam-top') as HTMLButtonElement,
		side: mount.querySelector('#lab-cam-side') as HTMLButtonElement,
		'3q': mount.querySelector('#lab-cam-3q') as HTMLButtonElement,
		free: mount.querySelector('#lab-cam-free') as HTMLButtonElement,
	};

	mount.querySelector('#lab-btn-run')!.addEventListener('click', () => callbacks.onRun());
	mount.querySelector('#lab-btn-reset')!.addEventListener('click', () => callbacks.onReset());
	slowMoBtn.addEventListener('click', () => callbacks.onToggleSlowMo());
	barrierBtn.addEventListener('click', () => callbacks.onToggleBarrier());
	mount.querySelector('#lab-btn-export')!.addEventListener('click', () => callbacks.onExport());
	(Object.keys(camBtns) as CameraPreset[]).forEach((p) => camBtns[p].addEventListener('click', () => callbacks.onCameraPreset(p)));
	fcSpeed.addEventListener('input', () => callbacks.onFreeConfigChange({ speedKmh: Number(fcSpeed.value) }));
	fcOffset.addEventListener('input', () => callbacks.onFreeConfigChange({ offsetM: Number(fcOffset.value) }));
	fcAngle.addEventListener('input', () => callbacks.onFreeConfigChange({ angleDeg: Number(fcAngle.value) }));

	let protocolButtons: Record<string, HTMLButtonElement> = {};

	const loadingEl = document.getElementById('hud-loading');
	const loadingFillEl = document.getElementById('hud-loading-fill');
	const loadingStatusEl = document.getElementById('hud-loading-status');

	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	return {
		setLoadingProgress(fraction, status) {
			if (loadingFillEl) loadingFillEl.style.width = `${Math.round(fraction * 100)}%`;
			if (loadingStatusEl) loadingStatusEl.textContent = status;
		},
		hideLoadingScreen() {
			loadingEl?.classList.add('hud-loading-hidden');
		},
		setProtocols(protocols, activeId) {
			protocolListEl.innerHTML = '';
			protocolButtons = {};
			for (const p of protocols) {
				const btn = document.createElement('button');
				btn.className = 'lab-protocol-btn' + (p.id === activeId ? ' lab-active' : '');
				btn.textContent = p.label;
				btn.addEventListener('click', () => callbacks.onSelectProtocol(p.id));
				protocolListEl.appendChild(btn);
				protocolButtons[p.id] = btn;
			}
			const active = protocols.find((p) => p.id === activeId);
			protocolSummaryEl.textContent = active ? `${active.summary} — ${active.reference}` : '';
			for (const [id, btn] of Object.entries(protocolButtons)) btn.classList.toggle('lab-active', id === activeId);
		},
		setFreeConfigVisible(visible) {
			freeConfigEl.style.display = visible ? 'block' : 'none';
		},
		setFreeConfigValues(state) {
			fcSpeed.value = String(state.speedKmh);
			fcOffset.value = String(state.offsetM);
			fcAngle.value = String(state.angleDeg);
			fcSpeedVal.textContent = `${state.speedKmh} km/h`;
			fcOffsetVal.textContent = `${state.offsetM.toFixed(2)} m`;
			fcAngleVal.textContent = `${state.angleDeg}°`;
		},
		setRunState(state, elapsedS, totalS) {
			runStateEl.className = `lab-run-state lab-${state}`;
			const label = state === 'idle' ? 'IDLE' : state === 'running' ? `RUNNING ${elapsedS.toFixed(1)}s / ${totalS.toFixed(1)}s` : `SETTLED (${elapsedS.toFixed(1)}s)`;
			runStateEl.textContent = label;
		},
		setBarrierHidden(hidden) {
			barrierBtn.classList.toggle('lab-active', hidden);
			barrierBtn.textContent = hidden ? 'Show barrier' : 'Hide barrier';
		},
		setSlowMo(enabled) {
			slowMoBtn.classList.toggle('lab-active', enabled);
		},
		setCameraPreset(preset) {
			(Object.keys(camBtns) as CameraPreset[]).forEach((p) => camBtns[p].classList.toggle('lab-active', p === preset));
		},
		updateReadout(data) {
			crushRowsEl.innerHTML = REGION_ORDER.map((r) => {
				const m = data.crush[r];
				return `<div class="lab-metric-row"><span>${REGION_LABELS[r]}</span><span>${m.depthM.toFixed(3)} (${m.dentedCount})</span></div>`;
			}).join('');
			panelChipsEl.innerHTML = PANEL_ORDER.map((k) => {
				const state = data.panelStates[k] ?? 'attached';
				const color = STATE_COLOR[state] ?? '#888';
				return `<div class="lab-chip" style="background:${color}" title="${PANEL_LABELS[k]}: ${state}">${PANEL_LABELS[k]}</div>`;
			}).join('');
			wheelChipsEl.innerHTML = WHEEL_ORDER.map((k) => {
				const state = data.wheelStates[k] ?? 'attached';
				const color = STATE_COLOR[state] ?? '#888';
				return `<div class="lab-chip" style="background:${color}" title="${WHEEL_LABELS[k]}: ${state}">${WHEEL_LABELS[k]}</div>`;
			}).join('');
			mechCrushEl.textContent = `${data.mechCrushFrontM.toFixed(3)} / ${data.mechCrushRearM.toFixed(3)}`;
			// Red past the FMVSS-208-inspired 0.15m leg-injury line (occupant model's intrusion term).
			(intrusionEl as HTMLElement).style.color = data.intrusionM > 0.15 ? '#ff5c5c' : '';
			intrusionEl.textContent = data.intrusionM.toFixed(3);
			dentedEl.textContent = String(data.dentedVertexCount);
			decelEl.textContent = `${data.chassisPeakDecelG.toFixed(1)} g`;
			occupantsEl.innerHTML = data.occupants
				.map((o) => {
					const cls = o.alive ? 'lab-alive' : 'lab-dead';
					const status = o.alive ? (o.ejected ? 'ejected' : o.state) : 'DEAD';
					return `<div class="lab-occupant-row"><span>${o.seatKey}</span><span class="${cls}">${status} · ${o.peakAccelG.toFixed(1)}g</span></div>`;
				})
				.join('');
		},
		showToast(message) {
			toastEl.textContent = message;
			toastEl.classList.add('lab-toast-visible');
			if (toastTimer) clearTimeout(toastTimer);
			toastTimer = setTimeout(() => toastEl.classList.remove('lab-toast-visible'), 2200);
		},
	};
}
