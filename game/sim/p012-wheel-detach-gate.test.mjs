// SPDX-License-Identifier: MIT
//
// P012: "wheels fly off too easily." The base wheel-detach force multiplier (WHEEL_DETACH_FORCE_MULT=4,
// ~14.4kN) sits INSIDE the documented 5-23kN ordinary-hard-driving band, so a hard-driving joint-force
// transient coincident with an incidental LOW-speed obstacle brush (which used to arm "impact context"
// at just 3 m/s) could tip a wheel off with no genuine crash. The fix raises the impact-context approach
// floor (WHEEL_DETACH_MIN_APPROACH_MS = 8 m/s ~ 29 km/h): only a genuine collision arms the base detach
// path. This test proves both halves -- ordinary aggressive driving never detaches, and the discriminator
// keys on approach speed (a 5 m/s brush does NOT arm the base path, a 16 m/s impact DOES).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';
import { CAR_ENTITY_ID, NEUTRAL_INPUT, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, GRAVITY_MAG } from '../src/vehicle/tuning.ts';
import { length } from '../src/vehicle/mathUtil.ts';
import { stepWeldsAndWheels } from '../src/damage/welds.ts';
import { WHEEL_DETACH_MIN_APPROACH_MS } from '../src/damage/damage-tuning.ts';

const BAND_IMPULSE_NS = 4050; // same in-band rear-wheel impulse reverse.test.mjs uses (~4x the share)

describe('P012: ordinary hard driving never detaches a wheel', () => {
  it('a full aggressive-driving battery (~600 steps, no obstacles) keeps all 4 wheels attached', async () => {
    const sim = await createDamageSim();
    try {
      const phases = [
        { throttle: 1, brake: 0, steer: 0, handbrake: false },
        { throttle: 1, brake: 0, steer: 0.7, handbrake: false },
        { throttle: 0, brake: 1, steer: -0.7, handbrake: false },
        { throttle: 1, brake: 0, steer: -0.6, handbrake: false },
        { throttle: 0.5, brake: 0, steer: 0.9, handbrake: true },
        { throttle: 0, brake: 1, steer: 0, handbrake: false },
      ];
      for (const phase of phases) for (let i = 0; i < 100; i++) sim.step(phase);
      const dt = sim.damageTelemetry();
      console.log(`[P012 battery] wheels=${JSON.stringify(dt.wheelStates)}`);
      for (const s of Object.values(dt.wheelStates)) expect(s).toBe('attached');
    } finally {
      sim.destroy();
    }
  }, 30000);
});

// Hand-drives physics + the wheel-detach gate with a precisely-controlled hit list (same technique as
// reverse.test.mjs), applying a SUSTAINED in-band rear-wheel force plus a coincident synthetic impact,
// to prove the approach-speed floor discriminates a brush from a genuine impact.
async function runWithCoincidentImpact(approachSpeed) {
  const sim = await createDamageSim();
  try {
    for (let i = 0; i < 30; i++) sim.step(NEUTRAL_INPUT);
    const share = (sim.damage.carMassKg * GRAVITY_MAG) / 4;
    // A car-touching, horizontal-normal hit far from every panel (z=1000) so it arms impact context
    // without polluting the accumulated-stress model (mirrors reverse.test.mjs's isolation trick).
    const hit = { userDataA: CAR_ENTITY_ID.chassis, userDataB: 9_999_999, point: { x: 0, y: 0, z: 1000 }, normal: { x: 1, y: 0, z: 0 }, approachSpeed };
    const counters = { fl: 0, fr: 0, rl: 0, rr: 0 };
    let detached = false;
    for (let i = 0; i < 24 && !detached; i++) {
      if (sim.vehicle.wheels.rl.joint) sim.vehicle.wheels.rl.body.applyLinearImpulseToCenter({ x: 0, y: 0, z: BAND_IMPULSE_NS }, true);
      stepVehicle(sim.vehicle, NEUTRAL_INPUT, FIXED_DT);
      sim.world.step(FIXED_DT, FIXED_SUBSTEPS);
      stepWeldsAndWheels({ world: sim.world, vehicle: sim.vehicle, panels: sim.damage.panels, hits: [hit], carMassKg: sim.damage.carMassKg, timeSec: 0, wheelOverThresholdSteps: counters, emit: () => {} });
      if (!sim.vehicle.wheels.rl.joint) detached = true;
    }
    console.log(`[P012 gate] approach=${approachSpeed} share=${(share / 1000).toFixed(1)}kN detached=${detached}`);
    return detached;
  } finally {
    sim.destroy();
  }
}

describe('P012: the impact-context gate keys on approach speed', () => {
  it(`a low-speed brush (${WHEEL_DETACH_MIN_APPROACH_MS - 3} m/s, below the floor) does NOT detach despite an in-band sustained load`, async () => {
    expect(await runWithCoincidentImpact(WHEEL_DETACH_MIN_APPROACH_MS - 3)).toBe(false);
  }, 30000);

  it('a genuine impact (16 m/s ~ 58 km/h, above the floor) DOES detach the same in-band load', async () => {
    expect(await runWithCoincidentImpact(16)).toBe(true);
  }, 30000);
});
