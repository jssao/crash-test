// DIAGNOSTIC ONLY, follow-up 2: direct hit-event evidence of panel<->ground contact during a 5s
// straight-line full-throttle run (panels have enableHitEvents=true, ground has userData 0 (default),
// panels have PANEL_ENTITY_ID 6-10 -- see panels.ts). Counts begin-touch events per pair to see how
// often the doors (lowest panels, see friction-instrument.test.mjs) actually make/break ground
// contact during ordinary driving.
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { PANEL_ENTITY_ID } from '../../src/damage/panels.ts';
import { CAR_ENTITY_ID } from '../../src/vehicle/vehicle.ts';

const PANEL_NAME_BY_ID = Object.fromEntries(Object.entries(PANEL_ENTITY_ID).map(([k, v]) => [v, k]));

describe('diag: friction instrument 3 (hit-event evidence of panel-ground contact)', () => {
	it('counts panel<->ground begin-touch hit events over a 5s full-throttle straight-line run', async () => {
		const sim = await createSim();
		try {
			const counts = {};
			let chassisGroundHits = 0;
			let otherHits = 0;
			for (let i = 0; i < 300; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const hits = sim.world.hitEvents();
				for (let k = 0; k < hits.count; k++) {
					const e = hits.at(k);
					const a = e.userDataA;
					const b = e.userDataB;
					const panelId = PANEL_NAME_BY_ID[a] ? a : PANEL_NAME_BY_ID[b] ? b : null;
					const otherId = panelId === a ? b : a;
					if (panelId !== null && otherId === 0) {
						const name = PANEL_NAME_BY_ID[panelId];
						counts[name] = (counts[name] || 0) + 1;
					} else if ((a === CAR_ENTITY_ID.chassis && b === 0) || (b === CAR_ENTITY_ID.chassis && a === 0)) {
						chassisGroundHits++;
					} else {
						otherHits++;
					}
				}
			}
			console.log(`[panel-ground-hits] over 5s full-throttle: panel<->ground begin-touch counts=${JSON.stringify(counts)} chassisHullVsGround=${chassisGroundHits} other=${otherHits}`);
		} finally {
			sim.destroy();
		}
	});
});
