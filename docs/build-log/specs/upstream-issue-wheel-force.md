# Draft upstream issue: `b3GetWheelJointForce()` sums a configured suspension LENGTH limit into the returned force

**Status:** ready to file. Confirmed present, with exact line citations, in our pinned vendor copy;
confirmed **still present, byte-identical, at upstream HEAD** (see `upstream-delta.md` — the one commit
between our pin and HEAD, "Ghost collision improvements (#61)", does not touch `wheel_joint.c`,
`joint.c`, or `joint.h`). Not fixed upstream as of this writing.

---

## Title

`b3GetWheelJointForce()` adds `lowerSuspensionLimit` (a config length, not an impulse) into the
returned constraint force, with a sign error on the upper-limit term

## Environment

- Repo: `https://github.com/erincatto/box3d`
- Commit tested: `52f1a254ad62a74c9f2a80052f436e2263b95214` ("Name cache (#53)", 2026-07-06)
- Also confirmed present, unchanged, at HEAD `ef8ef0187a6fb7d93fc847872a538096b4a5833d` ("Ghost
  collision improvements (#61)", 2026-07-08)
- Build config: single precision (`BOX3D_DOUBLE_PRECISION=OFF`, the default)
- Reached via the public API `b3Joint_GetConstraintForce(b3JointId)` (`include/box3d/box3d.h:1066`),
  which for a wheel joint dispatches to the internal `b3GetWheelJointForce()` (`src/joint.c:1143`)

## Root cause

`src/wheel_joint.c:353-374`:

```c
b3Vec3 b3GetWheelJointForce( b3World* world, b3JointSim* base )
{
	b3WorldTransform transformA = b3GetBodyTransform( world, base->bodyIdA );
	b3WheelJoint* joint = &base->wheelJoint;

	// impulse in joint space
	b3Vec3 impulse = {
		joint->linearImpulse.x,
		joint->linearImpulse.y,
		joint->lowerSuspensionLimit + joint->upperSuspensionImpulse + joint->suspensionSpringImpulse,
	};

	// convert impulse to force
	b3Vec3 force = b3MulSV( world->inv_h, impulse );
	...
```

The third (suspension-axis) component is built from **`joint->lowerSuspensionLimit`**
(`src/joint.h:274`) — a *configured length* (the suspension's lower travel limit in meters, e.g.
`-0.1`, set once from `b3WheelJointDef.lowerSuspensionLimit`, `include/box3d/types.h:965`, and never
itself an impulse) — instead of **`joint->lowerSuspensionImpulse`** (`src/joint.h:272`), the correctly
named, correctly-typed accumulated impulse sitting right next to it in the struct. There is also a
sign error: the upper term is added (`+ upperSuspensionImpulse`) instead of subtracted.

Every other place in the same file (and in `joint.c`) that assembles this exact quantity gets it
right, which makes the getter's version look like a copy-paste slip rather than a deliberate design:

- `src/wheel_joint.c:545`: `float suspensionImpulse = joint->suspensionSpringImpulse +
  joint->lowerSuspensionImpulse - joint->upperSuspensionImpulse;`
- `src/joint.c:1098`: `float axialImpulse = joint->suspensionSpringImpulse +
  joint->lowerSuspensionImpulse - joint->upperSuspensionImpulse;`

So the getter should almost certainly read:

```c
joint->suspensionSpringImpulse + joint->lowerSuspensionImpulse - joint->upperSuspensionImpulse,
```

As written, the returned force's suspension-axis component is dimensionally inconsistent (a length
literally added to two impulse quantities) even before accounting for the sign bug, and is
disconnected from the joint's actual reaction load.

## Minimal repro (standalone, public API only)

Sketch (not yet compiled against the vendor tree — a maintainer or our follow-up PR would flesh this
into `samples/sample_issues.cpp`-style, matching that file's existing `RegisterSample("Issues", ...)`
pattern):

```c
#include <box3d/box3d.h>
#include <stdio.h>

int main( void )
{
	b3WorldDef worldDef = b3DefaultWorldDef();
	worldDef.gravity = ( b3Vec3 ){ 0.0f, -10.0f, 0.0f };
	b3WorldId worldId = b3CreateWorld( &worldDef );

	// Static ground.
	b3BodyDef groundDef = b3DefaultBodyDef();
	b3BodyId groundId = b3CreateBody( worldId, &groundDef );
	b3ShapeDef groundShapeDef = b3DefaultShapeDef();
	b3Hull groundBox = b3MakeBox( 50.0f, 0.5f, 50.0f );
	b3HullData* groundHull = b3ComputeHull( groundBox.points, groundBox.count );
	b3CreateHullShape( groundId, &groundShapeDef, groundHull );

	// Dynamic chassis carrying real weight (e.g. ~800kg / 4 wheels -> ~2000N/wheel static share).
	b3BodyDef chassisDef = b3DefaultBodyDef();
	chassisDef.type = b3_dynamicBody;
	chassisDef.position = ( b3Pos ){ 0.0f, 1.0f, 0.0f };
	b3BodyId chassisId = b3CreateBody( worldId, &chassisDef );
	/* ... attach a mass-bearing shape to chassisId ... */

	// Wheel body + wheel joint with a nonzero lowerSuspensionLimit.
	b3BodyDef wheelDef = b3DefaultBodyDef();
	wheelDef.type = b3_dynamicBody;
	wheelDef.position = ( b3Pos ){ 0.0f, 0.6f, 1.0f };
	b3BodyId wheelId = b3CreateBody( worldId, &wheelDef );
	/* ... attach a wheel-shaped shape to wheelId ... */

	b3WheelJointDef wheelJointDef = b3DefaultWheelJointDef();
	wheelJointDef.base.bodyIdA = chassisId;
	wheelJointDef.base.bodyIdB = wheelId;
	wheelJointDef.enableSuspensionSpring = true;
	wheelJointDef.suspensionHertz = 3.0f;
	wheelJointDef.suspensionDampingRatio = 0.7f;
	wheelJointDef.enableSuspensionLimit = true;
	wheelJointDef.lowerSuspensionLimit = -0.1f;   // <-- this exact value contaminates the force readback
	wheelJointDef.upperSuspensionLimit = 0.1f;
	b3JointId wheelJointId = b3CreateWheelJoint( worldId, &wheelJointDef );

	// Let the suspension settle under gravity and carry real static load.
	for ( int i = 0; i < 120; ++i )
	{
		b3World_Step( worldId, 1.0f / 60.0f, 4 );
	}

	b3Vec3 force = b3Joint_GetConstraintForce( wheelJointId );
	printf( "wheel joint constraint force = (%f, %f, %f)\n", force.x, force.y, force.z );
	// EXPECTED: force.z (suspension axis, before rotation to world space) on the order of the wheel's
	// real static load (thousands of N for a normal car).
	// ACTUAL: contaminated by lowerSuspensionLimit (here -0.1) and the sign-flipped upper term; does
	// not track load in a physically meaningful way (see empirical corroboration below).

	b3DestroyWorld( worldId );
	return 0;
}
```

A JS-binding equivalent is exactly our own code path: `Joint.getConstraintForce()` in our TS wrapper
(`src/ts/joint.ts:41`) calls straight through to `b3js_Joint_GetConstraintForce` →
`b3Joint_GetConstraintForce` → `b3GetWheelJointForce` for any wheel joint — no translation layer of
ours is involved in producing the bad number.

## Empirical corroboration from our own game (independent of the standalone repro above)

We hit this readback in production use before finding the root cause, and worked around it rather than
trusting the API for wheel load-sensing (see `game/src/vehicle/tuning.ts:236-262` and
`game/src/damage/damage-tuning.ts:240-270` for the full in-repo writeup):

- Summed across all 4 wheels, `Joint.getConstraintForce()` read **~0 N at rest**, for a vehicle whose
  real static weight is ~14.4 kN. Cross-checked via `getSuspensionDeflection()` (a different, reliable
  API) at the same moment: all 4 wheels showed a sane, physically consistent ~0.12 m of compression —
  i.e. the wheels **are** genuinely loaded; only the force readback is wrong.
- Under a sustained large externally-applied impulse, the reading appeared to have an artificial
  ceiling around **~20-25 kN** regardless of how much larger the true applied load was; a single
  massive one-shot impulse (which should read higher, at least transiently) instead read a
  comparatively modest value while the wheel simply flew off.
- A genuinely light, **contactless** condition (rear wheels held in a high-slip stall at low speed
  while reversing, zero external impact) produced a **sustained ~14.5 kN plateau for ~80 consecutive
  steps** — about 4× the real per-wheel static share — from ordinary driving, no collision involved.

All three observations are consistent with a readback that is not actually tracking the joint's real
reaction load.

## Expected vs. Actual

- **Expected:** `b3Joint_GetConstraintForce()` on a wheel joint returns the true reaction force along
  the suspension axis, equal to `(suspensionSpringImpulse + lowerSuspensionImpulse -
  upperSuspensionImpulse) * inv_h`, rotated to world space — trackable against real load (e.g.
  cross-verifiable with `b3WheelJoint_GetSuspensionDeflection` or its wrapper).
- **Actual:** returns `(lowerSuspensionLimit + upperSuspensionImpulse + suspensionSpringImpulse) *
  inv_h` — a configured length constant added to two impulse terms with a sign error on one of them;
  reads near-zero at real static load, appears ceilinged under sustained heavy load, and reads large
  sustained false-positive values during an ordinary contactless drivetrain stall.

## Suggested fix

In `src/wheel_joint.c`, `b3GetWheelJointForce()`, replace the third component of the local `impulse`
literal:

```diff
- joint->lowerSuspensionLimit + joint->upperSuspensionImpulse + joint->suspensionSpringImpulse,
+ joint->suspensionSpringImpulse + joint->lowerSuspensionImpulse - joint->upperSuspensionImpulse,
```

matching the already-correct pattern at `src/wheel_joint.c:545` and `src/joint.c:1098`.
