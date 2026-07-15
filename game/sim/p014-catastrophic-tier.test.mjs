// SPDX-License-Identifier: MIT
//
// P014: "a 340 km/h crash should crush the car ~75%, but everything saturates at ~200 km/h." The extreme
// tier saturated by 55 m/s (~198 km/h), so 200 mph and 340 km/h read the same depth. A CATASTROPHIC tier
// (segments.ts CATASTROPHIC_FULL_SPEED_MS / catastrophic core+segment headroom; damage-tuning.ts's
// chassisSpeedCrushCapM catastrophic ramp) keeps front crush growing up to ~94 m/s. Target: at 94 m/s
// (340 km/h) frontal the mechanical front crush reads as a MAJORITY of the front half of the car (the
// firewall sits ~1.55m behind the nose tip; the front half spans ~2.5m), and is strictly deeper than the
// 55 m/s (198 km/h) result. Reference: screenshots/P014_340kmh-crash-deform/reference/ (front clip
// accordioned to/past the A-pillar, wheels shoved back).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

async function frontalCrush(speedKmh) {
  const sim = await createDamageSim();
  try {
    const wall = sim.spawnWall(12);
    sim.crash(speedKmh);
    for (let i = 0; i < 400; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
    const dt = sim.damageTelemetry();
    return { frontCrushM: dt.segments.frontCrushM, chassisZ: sim.vehicle.chassis.getPosition().z, wallZ: wall.getPosition().z };
  } finally {
    sim.destroy();
  }
}

describe('P014: catastrophic tier keeps front crush growing past the ~200 km/h plateau', () => {
  it('340 km/h front crush is a majority of the front half, and strictly deeper than 198 km/h (55 m/s)', async () => {
    const r198 = await frontalCrush(198); // 55.0 m/s -- the old extreme-tier full-scale point
    const r322 = await frontalCrush(322); // 89.4 m/s -- the reference "200mph" tier
    const r340 = await frontalCrush(340); // 94.4 m/s -- the P014 target closing speed
    console.log(`[P014] 198=${r198.frontCrushM.toFixed(3)} 322=${r322.frontCrushM.toFixed(3)} 340=${r340.frontCrushM.toFixed(3)} (chassisZ340=${r340.chassisZ.toFixed(2)} wallZ=${r340.wallZ.toFixed(2)})`);

    // Defended target: >=1.75m. The car's front half (nose tip to centre) is ~2.5m; the firewall sits
    // ~1.55m behind the nose. 1.75m of front crush caves the entire front clip past the firewall into the
    // A-pillar zone -- "a majority of the front half," matching the reference's near-total front loss.
    expect(r340.frontCrushM).toBeGreaterThanOrEqual(1.75);
    // Strictly deeper than the 55 m/s result (the "no longer saturates at ~200 km/h" guarantee).
    expect(r340.frontCrushM).toBeGreaterThan(r198.frontCrushM);
    // Monotonic through the catastrophic band (340 > 322 > 198).
    expect(r340.frontCrushM).toBeGreaterThan(r322.frontCrushM);
    expect(r322.frontCrushM).toBeGreaterThan(r198.frontCrushM);
    // No wall tunneling: the chassis origin still stops well short of the wall centre.
    expect(r340.chassisZ).toBeLessThan(r340.wallZ - 0.5);
  }, 60000);
});
