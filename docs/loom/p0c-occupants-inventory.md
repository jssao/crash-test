# Occupants Ragdoll System Inventory

**Task**: Inventory how occupant ragdolls work for reskinning as crash-test dummies and fixing seated positions.  
**Source Inspection**: `game/src/world/features/occupants/` + `game/src/vehicle/tuning.ts`

---

## A. RAGDOLL BODY: Physics Capsule Assembly

Each occupant is an **11-capsule rigid-body chain** with 11 internal joints (10 pure-internal + 1 lap-belt restraint).

### Body Parts (PART_KEYS)
```
pelvis, torso, head, upperArmL, upperArmR, forearmL, forearmR, thighL, thighR, shinL, shinR
```
**Source**: `tuning.ts:33–45`

### Capsule Geometry (per part)

| Part | Radius (m) | Half-Length (m) | Mass Frac. | Notes |
|------|-----------|-----------------|----------|-------|
| pelvis | 0.11 | 0.05 | 0.11 | Hip box |
| torso | 0.14 | 0.16 | 0.30 | Chest/spine column |
| head | 0.09 | 0.02 | 0.07 | Rendered as sphere in visuals |
| upperArm (L/R) | 0.05 | 0.13 | 0.03 each | Shoulder to elbow |
| forearm (L/R) | 0.045 | 0.12 | 0.02 each | Elbow to wrist |
| thigh (L/R) | 0.08 | 0.18 | 0.13 each | Hip to knee (seated @ +90°) |
| shin (L/R) | 0.06 | 0.18 | 0.08 each | Knee to ankle |

**Source**: `tuning.ts:85–93, 97–109`  
**Total Mass**: 55 kg (OCCUPANT_MASS_KG, tuning.ts:112)

### Joint Types & Limits

| Joint Name | Type | Parent ← Child | Cone Limit (rad) | Twist Limits (rad) |
|-----------|------|-----------|-----------------|-------------------|
| spine | SphericalJoint | pelvis ← torso | 0.35 | ±0.30 |
| neck | SphericalJoint | torso ← head | 0.60 | ±0.50 |
| shoulderL/R | SphericalJoint | torso ← upperArm | 1.40 | ±1.20 |
| elbowL/R | RevoluteJoint | upperArm ← forearm | — | -2.2…+2.2 rad |
| hipL/R | SphericalJoint | pelvis ← thigh | 1.00 | ±0.40 |
| kneeL/R | RevoluteJoint | thigh ← shin | — | -2.2…+2.2 rad |
| restraint (chassis ← pelvis) | SphericalJoint | chassis ← pelvis | 0.50 | ±0.35 |

**Source**: `physics.ts:358–405`, `tuning.ts:317–327`

### Spring Tuning (all ball joints)
- **Passive (seated calm)**: `BALL_SPRING_HERTZ = 3 Hz`, `BALL_SPRING_DAMPING = 1` (tuning.ts:330–331)
- **Braced (seated g-load)**: `SEATED_BRACE_HERTZ = 9 Hz` (tuning.ts:457)
- **Restraint brace**: `RESTRAINT_BRACE_HERTZ = 16 Hz`, `RESTRAINT_BRACE_DAMPING = 1` (tuning.ts:477–478)
- **Hinges (elbow/knee)**: `HINGE_SPRING_HERTZ = 1.5 Hz`, `HINGE_SPRING_DAMPING = 0.6` (tuning.ts:339–340)

---

## B. VISUALS: THREE Geometry & Materials per Part

Each ragdoll has a visuals layer that renders each physics body as a THREE mesh.

### Geometry Mapping

**Source**: `visuals.ts:25–35`

| Part Base | THREE Geometry | Parameters |
|-----------|----------------|------------|
| head | `THREE.SphereGeometry` | `(radius=0.09, widthSegments=12, heightSegments=8)` |
| torso, pelvis, arm, forearm, thigh, shin | `THREE.CapsuleGeometry` | `(radius, length=2×halfLen, capSubdivisions=4, radialSegments=8)` |

### Material & Color Assignment

**Source**: `visuals.ts:15–23`

```javascript
// Line 15–16: Color constants
const SKIN_COLOR = 0xd8a878;        // Tan/skin for head
const PANTS_COLOR = 0x2a2a30;       // Dark grey/black for pelvis, thigh, shin

// Line 18–23: colorFor(part, seatKey) function
// - head               → SKIN_COLOR (0xd8a878)
// - torso/upperArm/forearm → SHIRT_COLOR_SEED[seatKey]
// - pelvis/thigh/shin  → PANTS_COLOR (0x2a2a30)
```

**Shirt colors by seat (line 375–380):**

| Seat | Color Hex | Color Name |
|------|-----------|-----------|
| frontLeft | 0x2b6cb0 | Blue |
| frontRight | 0xb02b3f | Red |
| rearLeft | 0x2f8f4e | Green |
| rearRight | 0xd18f1a | Amber |

**Material Construction (line 46–54):**
```javascript
new THREE.MeshStandardMaterial({
  color: <computed>,
  roughness: 0.85,
  metalness: 0.0
})
```
One material per unique color (cached by hex value).

### Visuals Lifecycle
- **Build**: `buildOccupantVisual(occupant, seatKey)` creates group + 11 meshes
- **Sample**: `sampleOccupantVisual()` per fixed physics step (post-step) — records body transform
- **Apply**: `applyOccupantVisual(alpha)` per render frame — interpolates between physics steps
- **Dispose**: `disposeOccupantVisual()` frees geometries

**Source**: `visuals.ts:42–89`

### Reskinning Path
✓ Each part's mesh is a **distinct, swappable object** (not merged):
- `visual.parts[partKey].mesh` is a separate `THREE.Mesh` per body part
- Can replace geometry (e.g., styled dummy box for torso) and material independently
- Color is baked into the material, not vertex data
- Current colors live as hex constants (line 15–16) + lookup table (line 375–380)

---

## C. SEATING: Position & Restraint

### Seat Anchors (Chassis-Local)

**Source**: `tuning.ts:183–188 (SEAT_LOCAL)`

```javascript
export const SEAT_LOCAL: Record<SeatKey, V3> = {
  frontLeft:  { x:  0.42, y: 0.22, z:  0.55 },  // Left front seat
  frontRight: { x: -0.42, y: 0.22, z:  0.55 },  // Right front seat
  rearLeft:   { x:  0.42, y: 0.17, z: -1.05 },  // Left rear seat
  rearRight:  { x: -0.42, y: 0.17, z: -1.05 },  // Right rear seat
};
```

**Interpretation:**
- **X**: ±0.42 m (lateral; +X = car left per vehicle.ts convention)
- **Y**: 0.22 m (front), 0.17 m (rear) — floor height above chassis origin; rear seats 0.05 m lower to follow roof slope
- **Z**: +0.55 m (front axle), -1.05 m (rear axle) — forward (+Z) per chassis axis

**Verified via**: game/verify/feature-occupants.mjs (visual screenshot), features-occupants.test.mjs (stability), tuning.ts doc comments (MUSTANG-65 SWAP RE-FIT, lines 166–182)

### Restraint Joint (Lap Belt)

**Type**: `SphericalJoint` (chassis body ← pelvis body)

**Anchor Points:**
- **frameA (on chassis)**: `SEAT_LOCAL[seatKey]` — the seat's hip point (physics.ts:412)
- **frameB (on pelvis)**: `ATTACH.pelvisRestraint = {x: 0, y: -0.02, z: 0}` — local pelvis frame (tuning.ts:140)

**Joint Configuration (physics.ts:411–423):**
```javascript
world.createSphericalJoint(chassis, pelvis, {
  frameA: { position: seatLocal, rotation: rFrameA },
  frameB: { position: ATTACH.pelvisRestraint, rotation: rFrameB },
  enableSpring: true,
  hertz: BALL_SPRING_HERTZ,        // 3 Hz baseline
  dampingRatio: BALL_SPRING_DAMPING,
  enableConeLimit: true,
  coneAngle: RESTRAINT_CONE_RAD,    // 0.5 rad
  enableTwistLimit: true,
  lowerTwistAngle: -RESTRAINT_TWIST_RAD,  // -0.35 rad
  upperTwistAngle: RESTRAINT_TWIST_RAD,   // +0.35 rad
});
```

**Seated Pose Mechanics:**
1. Occupant spawns `SETTLE_DROP_M = 0.05` m **above** `SEAT_LOCAL.y` (tuning.ts:266)
2. Lap-restraint spring pulls pelvis DOWN over the first ~0.5 s (30 steps, RESTRAINT_ARM_STEPS; tuning.ts:228)
3. Every other joint in the chain starts at **zero error** by design — only the restraint starts mis-aligned
4. Rest pose `REST_OFFSET` for each part (tuning.ts:125–133):
   - Most parts: **IDENTITY** (vertical in chassis frame)
   - **Thigh only**: +90° rotation about X axis → seated hip bend baked into rest pose

**Source**: `physics.ts:407–423`, `tuning.ts:183–188, 228, 266, 125–133`

### Seat Pan (Physical Support)

A **minimal rigid seat surface** welded to the chassis (per feature ownership split):

- **Geometry**: Box with half-extents `{x: 0.22, y: 0.05, z: 0.22}` (tuning.ts:270)
- **Mass**: 4 kg (tuning.ts:306)
- **Friction**: 0.9 (tuning.ts:307)
- **Joint**: `WeldJoint(chassis, panBody)` — rigid, hertz=0 (physics.ts:616–624)
- **Position**: `SEAT_LOCAL` – `{0, SEAT_PAN_DROP_M, 0}` = `{0, -0.2, 0}` drop (physics.ts:596)
- **Collision Filter**: One category bit per seat; a seated occupant's mask includes only its own seat's bit (tuning.ts doc, lines 268–291)

**Source**: `physics.ts:594–626`, `tuning.ts:268–311`

---

## D. STATES: Life Cycle & State Machine

### State Machine (FSM)

**Active Layer**: `updateOccupantActive()` in `active.ts:578–619`  
**Possible States**: `'seated' | 'tumbling' | 'settled' | 'recover' | 'flee' | 'safe' | 'dead'`

**Source**: `active.ts:212`

### State Transitions

```
SPAWN/RESET
  ↓
'seated' (passive/braced springs by chassis g-load)
  │
  ├─→ [belt breaks] → 'tumbling' (low-tone protective flail)
  │     │
  │     ├─→ [settled on ground] → 'settled' (gather)
  │     │     │
  │     │     ├─→ [rest 1s] → 'recover' (get-up ramp, pelvis rises)
  │     │           │
  │     │           ├─→ [reach standing height] → 'flee' (walk away)
  │     │                 │
  │     │                 └─→ [distance >= FLEE_ARRIVED_M] → 'safe' (idle glance)
  │     │
  │     └─→ [blocked by geometry] → 'settled' (give up, stay down)
  │
  └─→ [peak head/torso accel > DEATH_PEAK_ACCEL_G] → 'dead' (limp forever)
```

**Source**: `active.ts:457–559` (updateEjectedFsm), `active.ts:401–417` (updateLifeDeath)

### Entry Points & Injury Model

**Life/Death Trigger** (active.ts:401–417):
```javascript
peakAccelG = max(headAccelG, torsoAccelG) over entire scenario
if (peakAccelG > DEATH_PEAK_ACCEL_G && alive) → alive = false, state = 'dead'
```
- **DEATH_PEAK_ACCEL_G = 65 g** (tuning.ts:493)
- **Unit**: 9.81 m/s² (GRAVITY_G_UNIT, tuning.ts:494)
- **Measurement**: Per-step linear acceleration change of head and torso bodies

**Ejection Trigger** (physics.ts:465–490, pollOccupantRestraint):
- **ARMED**: Only after `RESTRAINT_ARM_STEPS = 30` polls (~0.5 s at 60 Hz; tuning.ts:228)
- **Force gate**: `restraintJoint.getConstraintForce() >= RESTRAINT_FORCE_THRESHOLD_N[seatKey]`
  - Front seats: 20,000 N (tuning.ts:199)
  - Rear seats: 3,000 N (tuning.ts:210)
- **Crash gate** (new in Stage 2): Force over threshold WHILE chassis accel ≥ 2.5 g (windowed over 10 polls)
- **Sustain gate**: OR force over threshold for 6 consecutive polls (slow crush)

**Source**: `tuning.ts:228, 233, 255, 193–212`

### Reset Behavior (index.ts:99–106)

```javascript
reset(): void {
  teardownAll();  // Destroy all 4 occupants + seat pans + their joints
  seatAll();      // Recreate all 4 occupants fresh (settled pose, alive, seated)
}
```
- **Full rebuild** on every reset (both 'car' and 'world' cases)
- **Reason**: Old chassis is destroyed before reset() fires; its attached joints are already invalid
- **Use `forgetHandle()` not `.destroy()`** for the restraint/weld joints to avoid double-free

**Source**: `index.ts:99–106`, `physics.ts:68–79 (LIFECYCLE HAZARD doc)`

---

## E. TESTS: Coverage & Assertions

### Test Files

| File | Purpose | Assertions |
|------|---------|-----------|
| **features-occupants.test.mjs** | Headless physics tests | Seated stability (no eject under mild driving), mass fractions sum to 1, settle/stability behavior, ejection under crashes |
| **occupants-active.test.mjs** | FSM + muscle layer | Braced-vs-limp stiffness, muscle-overwhelm under high angular impulse, state transitions (tumble→settle→recover) |
| **occupants-escalation.test.mjs** | Ejection drama gradient | 30 km/h unbelted OK, 70 km/h rears eject (unbelted), fronts stay (belted), 140 km/h both eject |
| **diag/occupants-repro.test.mjs** | Solver transient reproduction | Spawn/reset settle spikes, sustain-gate validation (single spikes don't eject) |
| **diag/occupants-eject-detail.test.mjs** | Ejection contact & friction | Ejected occupant clears hull AABB, friction swap on break prevents gluing-to-pan |
| **diag/occupants-force-trace.test.mjs** | Restraint force instrumentation | Measured belt loads at various crash speeds (input for threshold tuning) |

**Source**: Lines 1–10 of each test file; specific test names from `describe()`/`it()` blocks

### Key Test Names

**features-occupants.test.mjs:**
- `occupants: mass fractions` — sum to 1 across all 11 parts ✓
- `occupants: seated-stability` — 10 s of varied driving, no eject, no NaN ✓
- (More tests beyond line 100 — see file for full suite)

**Run Command**:
```bash
npm run test sim/features-occupants.test.mjs
npm run test sim/occupants-active.test.mjs
npm run test sim/occupants-escalation.test.mjs
```

**Source**: game/sim/*.test.mjs (all files found in initial directory scan)

---

## Summary Table: For Reskinning / Positioning

| Component | Location (file:line) | Current Value | Swap Point |
|-----------|----------------------|---------------|----------|
| **Capsule dims** | tuning.ts:85–93 | See table A above | Update PART_DIMS[base] |
| **Skin color (head)** | visuals.ts:15 | 0xd8a878 | SKIN_COLOR constant |
| **Pants color (lower)** | visuals.ts:16 | 0x2a2a30 | PANTS_COLOR constant |
| **Shirt colors (4 seats)** | tuning.ts:375–380 | Blue/Red/Green/Amber | SHIRT_COLOR_SEED lookup |
| **Head geometry** | visuals.ts:28 | SphereGeometry | geometryFor(head) → swap spheres for dummy head box |
| **Limb geometry** | visuals.ts:34 | CapsuleGeometry | geometryFor(non-head) → swap capsules for styled segments |
| **Seat positions (4 seats)** | tuning.ts:183–188 | See table C above | SEAT_LOCAL[seatKey] |
| **Restraint threshold** | tuning.ts:199, 210 | 20k (front), 3k (rear) N | RESTRAINT_FORCE_THRESHOLD_N |
| **Seat pan shape** | tuning.ts:270 | Box halfExtents | SEAT_PAN_HALF_EXTENTS |
| **Joint limits** | tuning.ts:317–327 | Cone/twist radians | NECK_CONE_RAD, SPINE_CONE_RAD, etc. |

---

## Notes for Later Workers

1. **Visuals are per-part**: Each mesh is a separate THREE.Mesh object in `visual.parts[partKey].mesh`, making them independently replaceable. ✓ Swappable for dummy geometry.

2. **Seat positions are hardcoded chassis-local**: Not derived from car-map seat nodes (none exist). Empirically verified via settle/stability/ejection tests + visual screenshots.

3. **Rest pose is baked**: The seated hip bend (90° about X) is in `REST_OFFSET.thigh`, so straightening legs during recovery requires widening the hip cone to `RECOVER_HIP_CONE_RAD = 1.9 rad` (active.ts:114).

4. **Collision filtering (Stage 2)**: Ejected occupants have real interior collision via category/mask bits (not trajectory hacks). Seated occupants collide with their own seat pan only.

5. **Restoring springs are unconditionally stable** (solver-integrated, not explicit PD) for seated bracing. Ejected FSM uses muscle PD with per-body gain caps.

6. **Peak accel injury model** is the authoritative entry point for death (tuning.ts:493, active.ts:409). Occupants survive if peak head/torso accel ≤ 65 g.

---

*Inventory complete. Ready for reskinning and seating-position fixes.*
