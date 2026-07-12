// SPDX-License-Identifier: MIT
//
// Tiny typed event emitter for the damage system (G3 spec). Deliberately NOT the box3d-js binding's
// own event cursors (src/ts/events.ts, which are live per-physics-step views) -- these are ordinary
// retained JS objects, emitted synchronously and immediately handed to every listener, meant for
// gameplay/HUD/audio hooks (later) and telemetry counting (now). No three/DOM import (renderer-free).

import type { V3 } from '../vehicle/mathUtil';
import type { PanelKey } from './panels';
import type { WheelKey } from '../vehicle/vehicle';

export interface ImpactEvent {
	type: 'impact';
	severity: number; // approach speed, m/s
	point: V3;
}

export interface PanelLoosenedEvent {
	type: 'panelLoosened';
	panel: PanelKey;
}

/** DOORS ONLY (Stream C slice C1): the latch failed but the hinge holds -- panels.ts's
 * sprungPanelWeld(). */
export interface PanelSprungEvent {
	type: 'panelSprung';
	panel: PanelKey;
}

export interface PanelBrokenEvent {
	type: 'panelBroken';
	panel: PanelKey;
}

export interface PanelDespawnedEvent {
	type: 'panelDespawned';
	panel: PanelKey;
}

export interface WheelDetachedEvent {
	type: 'wheelDetached';
	i: WheelKey;
}

export interface GlassShatteredEvent {
	type: 'glassShattered';
	mesh: string;
}

/** Crush M2: a crush-segment weld tore clean off (constraint force above its tier's break threshold
 * -- extreme events only; see vehicle/segments.ts's stepSegmentYield()). */
export interface SegmentTornEvent {
	type: 'segmentTorn';
	weld: string;
}

export type DamageEvent =
	| ImpactEvent
	| PanelLoosenedEvent
	| PanelSprungEvent
	| PanelBrokenEvent
	| PanelDespawnedEvent
	| WheelDetachedEvent
	| GlassShatteredEvent
	| SegmentTornEvent;

export type DamageEventListener = (event: DamageEvent) => void;

/** Minimal pub/sub: `on()` to subscribe, `emit()` to publish (also appends to `.history` for
 * telemetry counting -- see game/src/damage/system.ts's DamageTelemetry). */
export class DamageEventEmitter {
	private listeners: DamageEventListener[] = [];
	readonly history: DamageEvent[] = [];

	on(listener: DamageEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	emit(event: DamageEvent): void {
		this.history.push(event);
		for (const l of this.listeners) l(event);
	}
}

export function createDamageEventEmitter(): DamageEventEmitter {
	return new DamageEventEmitter();
}
