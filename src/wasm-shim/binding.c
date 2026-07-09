// SPDX-License-Identifier: MIT
//
// box3d-js P1 binding shim (OUR code -- does not touch vendor/box3d).
//
// Compiled into the box3d.wasm module alongside the vendor box3d static lib (see
// scripts/wasm/CMakeLists.txt). Flattens Box3D's handle-struct/def-struct C API into a scalar-only
// surface that is cheap and simple to call from JS via Module.cwrap()/ccall():
//
//  - Handles (b3WorldId/b3BodyId/b3ShapeId/b3JointId) cross the JS boundary as `uint64_t`, bit-cast
//    from the id structs (b3WorldId is only 4 bytes -- zero-extended to 64 bits so every handle type
//    looks the same to JS). The module is linked with -sWASM_BIGINT so JS sees these as `bigint`.
//  - Def-struct creation functions (b3js_CreateBody, b3js_CreateSphereShape, b3js_CreateWeldJoint,
//    ...) take plain scalars and always start from the upstream b3Default*Def() before overriding
//    fields -- never a zero-initialized def.
//  - Entity identity: body/shape userData stores a uint32_t "entity id" (the JS-side game object key)
//    cast to void*. Hit events resolve shape -> entity id, falling back to the owning body's userData
//    if the shape itself has none, so JS event consumers never see raw b3ShapeId/b3BodyId handles.
//  - Per-step events (move/hit/joint) are drained by b3js_Step() into shim-owned growable buffers,
//    one set per world "slot" (keyed by b3WorldId.index1, stable for the life of that slot -- see
//    b3js_WorldSlot). JS reads them back as (ptr, count) and views the wasm heap directly
//    (HEAPU32/HEAPF32) -- zero per-event allocation in the hot path.
//
// Up-axis / handedness: Box3D itself is agnostic (b3WorldDef doc: "no up-vector defined"), but
// upstream's b3DefaultWorldDef() sets gravity = (0, -10, 0) -- i.e. **Y-down gravity, Y-up world**,
// matching Three.js's convention. b3Quat is {v:{x,y,z}, s} which maps directly onto
// `THREE.Quaternion(x, y, z, w=s)`.

#include <stdint.h>
#include <stdlib.h>

#include "box3d/box3d.h"

// ---------------------------------------------------------------------------------------------
// Handle pack/unpack. Body/Shape/Joint already have b3Store*Id/b3Load*Id helpers in box3d/id.h
// that pack into uint64_t; b3WorldId only has a uint32_t packer, so we zero-extend it ourselves to
// keep every handle the same width (and therefore the same JS type: bigint) at the boundary.
// ---------------------------------------------------------------------------------------------

static inline uint64_t b3js_PackWorldId( b3WorldId id )
{
	return (uint64_t)b3StoreWorldId( id );
}

static inline b3WorldId b3js_UnpackWorldId( uint64_t v )
{
	return b3LoadWorldId( (uint32_t)v );
}

static inline void* b3js_U32ToPtr( uint32_t v )
{
	return (void*)(uintptr_t)v;
}

static inline uint32_t b3js_PtrToU32( void* p )
{
	return (uint32_t)(uintptr_t)p;
}

// Resolve an entity id for a shape: prefer the shape's own userData; fall back to the owning
// body's userData. This means JS event consumers always get an application entity id, never a raw
// handle -- callers just need to tag *something* (shape or body) with an entity id at creation time.
static uint32_t b3js_EntityIdFromShape( b3ShapeId shapeId )
{
	void* shapeUserData = b3Shape_GetUserData( shapeId );
	if ( shapeUserData != NULL )
	{
		return b3js_PtrToU32( shapeUserData );
	}

	b3BodyId bodyId = b3Shape_GetBody( shapeId );
	void* bodyUserData = b3Body_GetUserData( bodyId );
	return b3js_PtrToU32( bodyUserData );
}

static inline b3Transform b3js_Frame( float px, float py, float pz, float qx, float qy, float qz, float qw )
{
	b3Transform t;
	t.p = ( b3Vec3 ){ px, py, pz };
	t.q = ( b3Quat ){ { qx, qy, qz }, qw };
	return t;
}

// ---------------------------------------------------------------------------------------------
// Event drain buffers -- one slot per possible world (B3_MAX_WORLDS == 128), each independently
// growable. Slots are keyed by b3WorldId.index1 (Box3D's own world pool index), which is stable
// and reused for the lifetime of a given world and typically reused by the *next* world created in
// that slot after a destroy -- so repeated create/step/destroy loops (see the memory-stability
// test) converge to a fixed buffer capacity instead of growing without bound.
// ---------------------------------------------------------------------------------------------

typedef struct b3jsMoveEvent
{
	uint32_t userData;
	float px, py, pz;
	float qx, qy, qz, qs;
	uint32_t flags; // bit 0 = fellAsleep
} b3jsMoveEvent;

typedef struct b3jsHitEvent
{
	uint32_t userDataA;
	uint32_t userDataB;
	float px, py, pz;
	float nx, ny, nz;
	float approachSpeed;
} b3jsHitEvent;

typedef struct b3jsJointEvent
{
	uint32_t userData;
} b3jsJointEvent;

typedef struct b3jsEventBuf
{
	void* data;
	int capacity; // in elements
	int count;	  // in elements
} b3jsEventBuf;

#define B3JS_MAX_WORLDS B3_MAX_WORLDS

static b3jsEventBuf s_moveBufs[B3JS_MAX_WORLDS];
static b3jsEventBuf s_hitBufs[B3JS_MAX_WORLDS];
static b3jsEventBuf s_jointBufs[B3JS_MAX_WORLDS];

static void b3js_EnsureCapacity( b3jsEventBuf* buf, int neededCount, size_t elemSize )
{
	if ( neededCount <= buf->capacity )
	{
		return;
	}

	int newCap = buf->capacity > 0 ? buf->capacity : 16;
	while ( newCap < neededCount )
	{
		newCap *= 2;
	}

	buf->data = realloc( buf->data, (size_t)newCap * elemSize );
	buf->capacity = newCap;
}

static int b3js_WorldSlot( b3WorldId worldId )
{
	int slot = worldId.index1 - 1;
	if ( slot < 0 )
	{
		slot = 0;
	}
	if ( slot >= B3JS_MAX_WORLDS )
	{
		slot = B3JS_MAX_WORLDS - 1;
	}
	return slot;
}

static void b3js_DrainEvents( b3WorldId worldId )
{
	int slot = b3js_WorldSlot( worldId );

	b3BodyEvents bodyEvents = b3World_GetBodyEvents( worldId );
	b3jsEventBuf* moveBuf = &s_moveBufs[slot];
	b3js_EnsureCapacity( moveBuf, bodyEvents.moveCount, sizeof( b3jsMoveEvent ) );
	b3jsMoveEvent* moveOut = (b3jsMoveEvent*)moveBuf->data;
	for ( int i = 0; i < bodyEvents.moveCount; i++ )
	{
		const b3BodyMoveEvent* ev = &bodyEvents.moveEvents[i];
		moveOut[i].userData = b3js_PtrToU32( ev->userData );
		moveOut[i].px = ev->transform.p.x;
		moveOut[i].py = ev->transform.p.y;
		moveOut[i].pz = ev->transform.p.z;
		moveOut[i].qx = ev->transform.q.v.x;
		moveOut[i].qy = ev->transform.q.v.y;
		moveOut[i].qz = ev->transform.q.v.z;
		moveOut[i].qs = ev->transform.q.s;
		moveOut[i].flags = ev->fellAsleep ? 1u : 0u;
	}
	moveBuf->count = bodyEvents.moveCount;

	b3ContactEvents contactEvents = b3World_GetContactEvents( worldId );
	b3jsEventBuf* hitBuf = &s_hitBufs[slot];
	b3js_EnsureCapacity( hitBuf, contactEvents.hitCount, sizeof( b3jsHitEvent ) );
	b3jsHitEvent* hitOut = (b3jsHitEvent*)hitBuf->data;
	for ( int i = 0; i < contactEvents.hitCount; i++ )
	{
		const b3ContactHitEvent* ev = &contactEvents.hitEvents[i];
		hitOut[i].userDataA = b3js_EntityIdFromShape( ev->shapeIdA );
		hitOut[i].userDataB = b3js_EntityIdFromShape( ev->shapeIdB );
		hitOut[i].px = ev->point.x;
		hitOut[i].py = ev->point.y;
		hitOut[i].pz = ev->point.z;
		hitOut[i].nx = ev->normal.x;
		hitOut[i].ny = ev->normal.y;
		hitOut[i].nz = ev->normal.z;
		hitOut[i].approachSpeed = ev->approachSpeed;
	}
	hitBuf->count = contactEvents.hitCount;

	b3JointEvents jointEvents = b3World_GetJointEvents( worldId );
	b3jsEventBuf* jointBuf = &s_jointBufs[slot];
	b3js_EnsureCapacity( jointBuf, jointEvents.count, sizeof( b3jsJointEvent ) );
	b3jsJointEvent* jointOut = (b3jsJointEvent*)jointBuf->data;
	for ( int i = 0; i < jointEvents.count; i++ )
	{
		jointOut[i].userData = b3js_PtrToU32( jointEvents.jointEvents[i].userData );
	}
	jointBuf->count = jointEvents.count;
}

// =================================================================================================
// World
// =================================================================================================

uint64_t b3js_CreateWorld( float gx, float gy, float gz, float hitEventThreshold, float contactHertz,
						   float contactDampingRatio, int enableSleep, int enableContinuous )
{
	b3WorldDef def = b3DefaultWorldDef();
	def.gravity = ( b3Vec3 ){ gx, gy, gz };
	def.hitEventThreshold = hitEventThreshold;
	def.contactHertz = contactHertz;
	def.contactDampingRatio = contactDampingRatio;
	def.enableSleep = enableSleep != 0;
	def.enableContinuous = enableContinuous != 0;

	b3WorldId worldId = b3CreateWorld( &def );

	int slot = b3js_WorldSlot( worldId );
	s_moveBufs[slot].count = 0;
	s_hitBufs[slot].count = 0;
	s_jointBufs[slot].count = 0;

	return b3js_PackWorldId( worldId );
}

void b3js_DestroyWorld( uint64_t worldId64 )
{
	b3DestroyWorld( b3js_UnpackWorldId( worldId64 ) );
}

int b3js_World_IsValid( uint64_t worldId64 )
{
	return b3World_IsValid( b3js_UnpackWorldId( worldId64 ) ) ? 1 : 0;
}

// Steps the world AND drains move/hit/joint events into this world's buffers. This is the only
// stepping entry point exposed -- see b3js_GetMoveEventsPtr/Count etc. to read the drained events.
void b3js_Step( uint64_t worldId64, float dt, int subStepCount )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3World_Step( worldId, dt, subStepCount );
	b3js_DrainEvents( worldId );
}

void b3js_World_SetGravity( uint64_t worldId64, float gx, float gy, float gz )
{
	b3World_SetGravity( b3js_UnpackWorldId( worldId64 ), ( b3Vec3 ){ gx, gy, gz } );
}

// outPtr must have room for 3 floats.
void b3js_World_GetGravity( uint64_t worldId64, float* outPtr )
{
	b3Vec3 g = b3World_GetGravity( b3js_UnpackWorldId( worldId64 ) );
	outPtr[0] = g.x;
	outPtr[1] = g.y;
	outPtr[2] = g.z;
}

int32_t b3js_GetMoveEventsPtr( uint64_t worldId64 )
{
	int slot = b3js_WorldSlot( b3js_UnpackWorldId( worldId64 ) );
	return (int32_t)(intptr_t)s_moveBufs[slot].data;
}

int32_t b3js_GetMoveEventsCount( uint64_t worldId64 )
{
	int slot = b3js_WorldSlot( b3js_UnpackWorldId( worldId64 ) );
	return s_moveBufs[slot].count;
}

int32_t b3js_GetHitEventsPtr( uint64_t worldId64 )
{
	int slot = b3js_WorldSlot( b3js_UnpackWorldId( worldId64 ) );
	return (int32_t)(intptr_t)s_hitBufs[slot].data;
}

int32_t b3js_GetHitEventsCount( uint64_t worldId64 )
{
	int slot = b3js_WorldSlot( b3js_UnpackWorldId( worldId64 ) );
	return s_hitBufs[slot].count;
}

int32_t b3js_GetJointEventsPtr( uint64_t worldId64 )
{
	int slot = b3js_WorldSlot( b3js_UnpackWorldId( worldId64 ) );
	return (int32_t)(intptr_t)s_jointBufs[slot].data;
}

int32_t b3js_GetJointEventsCount( uint64_t worldId64 )
{
	int slot = b3js_WorldSlot( b3js_UnpackWorldId( worldId64 ) );
	return s_jointBufs[slot].count;
}

// Closest-hit ray cast. outPtr must have room for 8 floats: [hit(0/1), px,py,pz, nx,ny,nz, fraction].
// Returns the entity id of the hit shape (see b3js_EntityIdFromShape), or 0 if no hit.
uint32_t b3js_CastRayClosest( uint64_t worldId64, float ox, float oy, float oz, float tx, float ty, float tz,
							   uint64_t categoryBits, uint64_t maskBits, float* outPtr )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3QueryFilter filter = b3DefaultQueryFilter();
	filter.categoryBits = categoryBits;
	filter.maskBits = maskBits;

	b3Vec3 origin = { ox, oy, oz };
	b3Vec3 translation = { tx, ty, tz };
	b3RayResult result = b3World_CastRayClosest( worldId, origin, translation, filter );

	outPtr[0] = result.hit ? 1.0f : 0.0f;
	outPtr[1] = result.point.x;
	outPtr[2] = result.point.y;
	outPtr[3] = result.point.z;
	outPtr[4] = result.normal.x;
	outPtr[5] = result.normal.y;
	outPtr[6] = result.normal.z;
	outPtr[7] = result.fraction;

	if ( !result.hit )
	{
		return 0;
	}
	return b3js_EntityIdFromShape( result.shapeId );
}

// =================================================================================================
// Body
// =================================================================================================

uint64_t b3js_CreateBody( uint64_t worldId64, int type, float px, float py, float pz, float qx, float qy, float qz,
						   float qw, float linearDamping, float angularDamping, float gravityScale, int enableSleep,
						   int isBullet, int allowFastRotation, uint32_t userData )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3BodyDef def = b3DefaultBodyDef();
	def.type = (b3BodyType)type;
	def.position = ( b3Vec3 ){ px, py, pz };
	def.rotation = ( b3Quat ){ { qx, qy, qz }, qw };
	def.linearDamping = linearDamping;
	def.angularDamping = angularDamping;
	def.gravityScale = gravityScale;
	def.enableSleep = enableSleep != 0;
	def.isBullet = isBullet != 0;
	// Exempts this body from box3d's per-step angular-velocity safety clamp (B3_MAX_ROTATION*inv_dt,
	// see vendor/box3d/src/solver.c's b3IntegratePositionsTask() and constants.h) -- upstream's own
	// doc comment on this field: "Should only be used for circular objects, like wheels."
	def.allowFastRotation = allowFastRotation != 0;
	def.userData = b3js_U32ToPtr( userData );

	b3BodyId bodyId = b3CreateBody( worldId, &def );
	return b3StoreBodyId( bodyId );
}

void b3js_DestroyBody( uint64_t bodyId64 )
{
	b3DestroyBody( b3LoadBodyId( bodyId64 ) );
}

int b3js_Body_IsValid( uint64_t bodyId64 )
{
	return b3Body_IsValid( b3LoadBodyId( bodyId64 ) ) ? 1 : 0;
}

// outPtr must have room for 7 floats: [px,py,pz, qx,qy,qz,qw].
void b3js_Body_GetTransform( uint64_t bodyId64, float* outPtr )
{
	b3WorldTransform t = b3Body_GetTransform( b3LoadBodyId( bodyId64 ) );
	outPtr[0] = t.p.x;
	outPtr[1] = t.p.y;
	outPtr[2] = t.p.z;
	outPtr[3] = t.q.v.x;
	outPtr[4] = t.q.v.y;
	outPtr[5] = t.q.v.z;
	outPtr[6] = t.q.s;
}

void b3js_Body_SetTransform( uint64_t bodyId64, float px, float py, float pz, float qx, float qy, float qz, float qw )
{
	b3Body_SetTransform( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ px, py, pz }, ( b3Quat ){ { qx, qy, qz }, qw } );
}

// outPtr must have room for 3 floats.
void b3js_Body_GetLinearVelocity( uint64_t bodyId64, float* outPtr )
{
	b3Vec3 v = b3Body_GetLinearVelocity( b3LoadBodyId( bodyId64 ) );
	outPtr[0] = v.x;
	outPtr[1] = v.y;
	outPtr[2] = v.z;
}

void b3js_Body_SetLinearVelocity( uint64_t bodyId64, float x, float y, float z )
{
	b3Body_SetLinearVelocity( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ x, y, z } );
}

// outPtr must have room for 3 floats.
void b3js_Body_GetAngularVelocity( uint64_t bodyId64, float* outPtr )
{
	b3Vec3 v = b3Body_GetAngularVelocity( b3LoadBodyId( bodyId64 ) );
	outPtr[0] = v.x;
	outPtr[1] = v.y;
	outPtr[2] = v.z;
}

void b3js_Body_SetAngularVelocity( uint64_t bodyId64, float x, float y, float z )
{
	b3Body_SetAngularVelocity( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ x, y, z } );
}

void b3js_Body_ApplyForce( uint64_t bodyId64, float fx, float fy, float fz, float px, float py, float pz, int wake )
{
	b3Body_ApplyForce( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ fx, fy, fz }, ( b3Vec3 ){ px, py, pz }, wake != 0 );
}

void b3js_Body_ApplyForceToCenter( uint64_t bodyId64, float fx, float fy, float fz, int wake )
{
	b3Body_ApplyForceToCenter( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ fx, fy, fz }, wake != 0 );
}

void b3js_Body_ApplyTorque( uint64_t bodyId64, float tx, float ty, float tz, int wake )
{
	b3Body_ApplyTorque( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ tx, ty, tz }, wake != 0 );
}

void b3js_Body_ApplyLinearImpulse( uint64_t bodyId64, float ix, float iy, float iz, float px, float py, float pz,
									int wake )
{
	b3Body_ApplyLinearImpulse( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ ix, iy, iz }, ( b3Vec3 ){ px, py, pz },
								wake != 0 );
}

void b3js_Body_ApplyLinearImpulseToCenter( uint64_t bodyId64, float ix, float iy, float iz, int wake )
{
	b3Body_ApplyLinearImpulseToCenter( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ ix, iy, iz }, wake != 0 );
}

void b3js_Body_ApplyAngularImpulse( uint64_t bodyId64, float ix, float iy, float iz, int wake )
{
	b3Body_ApplyAngularImpulse( b3LoadBodyId( bodyId64 ), ( b3Vec3 ){ ix, iy, iz }, wake != 0 );
}

float b3js_Body_GetMass( uint64_t bodyId64 )
{
	return b3Body_GetMass( b3LoadBodyId( bodyId64 ) );
}

void b3js_Body_ApplyMassFromShapes( uint64_t bodyId64 )
{
	b3Body_ApplyMassFromShapes( b3LoadBodyId( bodyId64 ) );
}

// outPtr must have room for 13 floats: [mass, cx,cy,cz, ixxCol.x,ixxCol.y,ixxCol.z, iyyCol.x,iyyCol.y,
// iyyCol.z, izzCol.x,izzCol.y,izzCol.z] -- mass, local-space center of mass, then the 3x3 inertia
// matrix (about that center of mass) as its 3 column vectors (b3Matrix3.cx/cy/cz), matching
// b3MassData's layout in vendor/box3d/include/box3d/types.h.
void b3js_Body_GetMassData( uint64_t bodyId64, float* outPtr )
{
	b3MassData m = b3Body_GetMassData( b3LoadBodyId( bodyId64 ) );
	outPtr[0] = m.mass;
	outPtr[1] = m.center.x;
	outPtr[2] = m.center.y;
	outPtr[3] = m.center.z;
	outPtr[4] = m.inertia.cx.x;
	outPtr[5] = m.inertia.cx.y;
	outPtr[6] = m.inertia.cx.z;
	outPtr[7] = m.inertia.cy.x;
	outPtr[8] = m.inertia.cy.y;
	outPtr[9] = m.inertia.cy.z;
	outPtr[10] = m.inertia.cz.x;
	outPtr[11] = m.inertia.cz.y;
	outPtr[12] = m.inertia.cz.z;
}

// Overrides the body's mass properties (see b3Body_SetMassData's doc comment: lost if a shape is
// added/removed or the body type changes). Scalar layout mirrors b3js_Body_GetMassData's outPtr.
void b3js_Body_SetMassData( uint64_t bodyId64, float mass, float centerX, float centerY, float centerZ,
							 float cxX, float cxY, float cxZ, float cyX, float cyY, float cyZ, float czX, float czY,
							 float czZ )
{
	b3MassData m;
	m.mass = mass;
	m.center = ( b3Vec3 ){ centerX, centerY, centerZ };
	m.inertia.cx = ( b3Vec3 ){ cxX, cxY, cxZ };
	m.inertia.cy = ( b3Vec3 ){ cyX, cyY, cyZ };
	m.inertia.cz = ( b3Vec3 ){ czX, czY, czZ };
	b3Body_SetMassData( b3LoadBodyId( bodyId64 ), m );
}

// outPtr must have room for 3 floats. Center of mass position in body-local space.
void b3js_Body_GetLocalCenter( uint64_t bodyId64, float* outPtr )
{
	b3Vec3 c = b3Body_GetLocalCenter( b3LoadBodyId( bodyId64 ) );
	outPtr[0] = c.x;
	outPtr[1] = c.y;
	outPtr[2] = c.z;
}

void b3js_Body_SetAwake( uint64_t bodyId64, int awake )
{
	b3Body_SetAwake( b3LoadBodyId( bodyId64 ), awake != 0 );
}

int b3js_Body_IsAwake( uint64_t bodyId64 )
{
	return b3Body_IsAwake( b3LoadBodyId( bodyId64 ) ) ? 1 : 0;
}

void b3js_Body_EnableSleep( uint64_t bodyId64, int enable )
{
	b3Body_EnableSleep( b3LoadBodyId( bodyId64 ), enable != 0 );
}

void b3js_Body_SetUserData( uint64_t bodyId64, uint32_t userData )
{
	b3Body_SetUserData( b3LoadBodyId( bodyId64 ), b3js_U32ToPtr( userData ) );
}

uint32_t b3js_Body_GetUserData( uint64_t bodyId64 )
{
	return b3js_PtrToU32( b3Body_GetUserData( b3LoadBodyId( bodyId64 ) ) );
}

// =================================================================================================
// Shapes
// =================================================================================================

static void b3js_FillShapeDef( b3ShapeDef* def, float density, float friction, float restitution,
								float rollingResistance, int enableContactEvents, int enableHitEvents, int isSensor,
								uint64_t categoryBits, uint64_t maskBits, int groupIndex, uint32_t userData )
{
	*def = b3DefaultShapeDef();
	def->density = density;
	def->baseMaterial.friction = friction;
	def->baseMaterial.restitution = restitution;
	def->baseMaterial.rollingResistance = rollingResistance;
	def->enableContactEvents = enableContactEvents != 0;
	def->enableHitEvents = enableHitEvents != 0;
	def->isSensor = isSensor != 0;
	def->filter.categoryBits = categoryBits;
	def->filter.maskBits = maskBits;
	def->filter.groupIndex = groupIndex;
	def->userData = b3js_U32ToPtr( userData );
}

uint64_t b3js_CreateSphereShape( uint64_t bodyId64, float cx, float cy, float cz, float radius, float density,
								  float friction, float restitution, float rollingResistance, int enableContactEvents,
								  int enableHitEvents, int isSensor, uint64_t categoryBits, uint64_t maskBits,
								  int groupIndex, uint32_t userData )
{
	b3BodyId bodyId = b3LoadBodyId( bodyId64 );
	b3ShapeDef def;
	b3js_FillShapeDef( &def, density, friction, restitution, rollingResistance, enableContactEvents,
						enableHitEvents, isSensor, categoryBits, maskBits, groupIndex, userData );

	b3Sphere sphere = { { cx, cy, cz }, radius };
	b3ShapeId shapeId = b3CreateSphereShape( bodyId, &def, &sphere );
	return b3StoreShapeId( shapeId );
}

uint64_t b3js_CreateCapsuleShape( uint64_t bodyId64, float c1x, float c1y, float c1z, float c2x, float c2y, float c2z,
								   float radius, float density, float friction, float restitution,
								   float rollingResistance, int enableContactEvents, int enableHitEvents,
								   int isSensor, uint64_t categoryBits, uint64_t maskBits, int groupIndex,
								   uint32_t userData )
{
	b3BodyId bodyId = b3LoadBodyId( bodyId64 );
	b3ShapeDef def;
	b3js_FillShapeDef( &def, density, friction, restitution, rollingResistance, enableContactEvents,
						enableHitEvents, isSensor, categoryBits, maskBits, groupIndex, userData );

	b3Capsule capsule = { { c1x, c1y, c1z }, { c2x, c2y, c2z }, radius };
	b3ShapeId shapeId = b3CreateCapsuleShape( bodyId, &def, &capsule );
	return b3StoreShapeId( shapeId );
}

// Box shapes have no native rigid-body primitive in Box3D; upstream's own recommended path is a
// hull built by b3MakeBoxHull (collision.h) -- "Do not call b3DestroyHull on this", it is a
// self-contained stack value copied by b3CreateHullShape (via the world's hull database, which
// clones by content) rather than referenced afterward.
uint64_t b3js_CreateBoxShape( uint64_t bodyId64, float hx, float hy, float hz, float density, float friction,
							   float restitution, float rollingResistance, int enableContactEvents,
							   int enableHitEvents, int isSensor, uint64_t categoryBits, uint64_t maskBits,
							   int groupIndex, uint32_t userData )
{
	b3BodyId bodyId = b3LoadBodyId( bodyId64 );
	b3ShapeDef def;
	b3js_FillShapeDef( &def, density, friction, restitution, rollingResistance, enableContactEvents,
						enableHitEvents, isSensor, categoryBits, maskBits, groupIndex, userData );

	b3BoxHull boxHull = b3MakeBoxHull( hx, hy, hz );
	b3ShapeId shapeId = b3CreateHullShape( bodyId, &def, &boxHull.base );
	return b3StoreShapeId( shapeId );
}

// Generic convex hull from a flat (x,y,z)-tuple point array (pointsPtr has 3*pointCount floats).
// b3CreateHull heap-allocates; the world's hull database (b3AddHullToDatabase) clones by content, so
// we free our copy immediately after -- no leak.
uint64_t b3js_CreateHullShape( uint64_t bodyId64, const float* pointsPtr, int pointCount, float density,
								float friction, float restitution, float rollingResistance, int enableContactEvents,
								int enableHitEvents, int isSensor, uint64_t categoryBits, uint64_t maskBits,
								int groupIndex, uint32_t userData )
{
	b3BodyId bodyId = b3LoadBodyId( bodyId64 );
	b3ShapeDef def;
	b3js_FillShapeDef( &def, density, friction, restitution, rollingResistance, enableContactEvents,
						enableHitEvents, isSensor, categoryBits, maskBits, groupIndex, userData );

	// b3Vec3 is exactly 3 contiguous floats, so the flat point buffer can be reinterpreted directly.
	const b3Vec3* points = (const b3Vec3*)pointsPtr;
	b3HullData* hull = b3CreateHull( points, pointCount, 255 );
	if ( hull == NULL )
	{
		return 0;
	}

	b3ShapeId shapeId = b3CreateHullShape( bodyId, &def, hull );
	b3DestroyHull( hull );
	return b3StoreShapeId( shapeId );
}

// Triangle mesh shape for static props/terrain-like geometry (verticesPtr: 3*vertexCount floats,
// indicesPtr: 3*triangleCount int32s).
//
// NOTE (documented deviation/limitation): unlike hulls, box3d's b3CreateMeshShape stores the raw
// b3MeshData* pointer on the shape rather than copying it (see vendor/box3d/src/shape.c,
// b3CreateShapeInternal's b3_meshShape case) -- meshes are meant to be created once and shared. This
// shim does not track mesh allocations for later b3DestroyMesh, so each call intentionally retains
// its b3MeshData for the life of the process. Fine for static level geometry created a handful of
// times; do not call this in a hot per-frame loop. Same caveat applies to b3js_CreateHeightFieldShape.
uint64_t b3js_CreateMeshShape( uint64_t bodyId64, const float* verticesPtr, int vertexCount, const int32_t* indicesPtr,
								int triangleCount, float sx, float sy, float sz, float density, float friction,
								float restitution, float rollingResistance, int enableContactEvents,
								int enableHitEvents, int isSensor, uint64_t categoryBits, uint64_t maskBits,
								int groupIndex, uint32_t userData )
{
	b3BodyId bodyId = b3LoadBodyId( bodyId64 );
	b3ShapeDef def;
	b3js_FillShapeDef( &def, density, friction, restitution, rollingResistance, enableContactEvents,
						enableHitEvents, isSensor, categoryBits, maskBits, groupIndex, userData );

	b3MeshDef meshDef = { 0 };
	meshDef.vertices = (b3Vec3*)(uintptr_t)verticesPtr;
	meshDef.indices = (int32_t*)(uintptr_t)indicesPtr;
	meshDef.materialIndices = NULL;
	meshDef.weldTolerance = 0.0f;
	meshDef.vertexCount = vertexCount;
	meshDef.triangleCount = triangleCount;
	meshDef.weldVertices = false;
	meshDef.useMedianSplit = false;
	meshDef.identifyEdges = false;

	b3MeshData* mesh = b3CreateMesh( &meshDef, NULL, 0 );
	if ( mesh == NULL )
	{
		return 0;
	}

	b3Vec3 scale = { sx, sy, sz };
	b3ShapeId shapeId = b3CreateMeshShape( bodyId, &def, mesh, scale );
	return b3StoreShapeId( shapeId );
}

// Height field shape for terrain (heightsPtr: countX*countZ floats, row-major). See the leak caveat
// on b3js_CreateMeshShape above -- applies here too (shape stores the raw b3HeightFieldData*).
uint64_t b3js_CreateHeightFieldShape( uint64_t bodyId64, const float* heightsPtr, int countX, int countZ, float sx,
									   float sy, float sz, float globalMinimumHeight, float globalMaximumHeight,
									   int clockwiseWinding, float density, float friction, float restitution,
									   float rollingResistance, int enableContactEvents, int enableHitEvents,
									   int isSensor, uint64_t categoryBits, uint64_t maskBits, int groupIndex,
									   uint32_t userData )
{
	b3BodyId bodyId = b3LoadBodyId( bodyId64 );
	b3ShapeDef def;
	b3js_FillShapeDef( &def, density, friction, restitution, rollingResistance, enableContactEvents,
						enableHitEvents, isSensor, categoryBits, maskBits, groupIndex, userData );

	b3HeightFieldDef hfDef = { 0 };
	hfDef.heights = (float*)(uintptr_t)heightsPtr;
	hfDef.materialIndices = NULL;
	hfDef.scale = ( b3Vec3 ){ sx, sy, sz };
	hfDef.countX = countX;
	hfDef.countZ = countZ;
	hfDef.globalMinimumHeight = globalMinimumHeight;
	hfDef.globalMaximumHeight = globalMaximumHeight;
	hfDef.clockwiseWinding = clockwiseWinding != 0;

	b3HeightFieldData* hf = b3CreateHeightField( &hfDef );
	if ( hf == NULL )
	{
		return 0;
	}

	b3ShapeId shapeId = b3CreateHeightFieldShape( bodyId, &def, hf );
	return b3StoreShapeId( shapeId );
}

// NOTE: b3CreateCompoundShape is deferred -- see docs/loom P1 report. b3CompoundDef bundles
// per-child-type arrays (b3CompoundCapsuleDef/HullDef/MeshDef/SphereDef) that would need their own
// flattened builder API on top of an already large surface; none of the required test scenarios need
// it, so it is left for a follow-up rather than rushed.

void b3js_DestroyShape( uint64_t shapeId64, int updateBodyMass )
{
	b3DestroyShape( b3LoadShapeId( shapeId64 ), updateBodyMass != 0 );
}

int b3js_Shape_IsValid( uint64_t shapeId64 )
{
	return b3Shape_IsValid( b3LoadShapeId( shapeId64 ) ) ? 1 : 0;
}

void b3js_Shape_SetUserData( uint64_t shapeId64, uint32_t userData )
{
	b3Shape_SetUserData( b3LoadShapeId( shapeId64 ), b3js_U32ToPtr( userData ) );
}

uint32_t b3js_Shape_GetUserData( uint64_t shapeId64 )
{
	return b3js_PtrToU32( b3Shape_GetUserData( b3LoadShapeId( shapeId64 ) ) );
}

void b3js_Shape_EnableContactEvents( uint64_t shapeId64, int flag )
{
	b3Shape_EnableContactEvents( b3LoadShapeId( shapeId64 ), flag != 0 );
}

void b3js_Shape_EnableHitEvents( uint64_t shapeId64, int flag )
{
	b3Shape_EnableHitEvents( b3LoadShapeId( shapeId64 ), flag != 0 );
}

// =================================================================================================
// Joints -- common
// =================================================================================================

void b3js_DestroyJoint( uint64_t jointId64, int wakeAttached )
{
	b3DestroyJoint( b3LoadJointId( jointId64 ), wakeAttached != 0 );
}

int b3js_Joint_IsValid( uint64_t jointId64 )
{
	return b3Joint_IsValid( b3LoadJointId( jointId64 ) ) ? 1 : 0;
}

// outPtr must have room for 3 floats.
void b3js_Joint_GetConstraintForce( uint64_t jointId64, float* outPtr )
{
	b3Vec3 f = b3Joint_GetConstraintForce( b3LoadJointId( jointId64 ) );
	outPtr[0] = f.x;
	outPtr[1] = f.y;
	outPtr[2] = f.z;
}

// outPtr must have room for 3 floats.
void b3js_Joint_GetConstraintTorque( uint64_t jointId64, float* outPtr )
{
	b3Vec3 t = b3Joint_GetConstraintTorque( b3LoadJointId( jointId64 ) );
	outPtr[0] = t.x;
	outPtr[1] = t.y;
	outPtr[2] = t.z;
}

void b3js_Joint_SetUserData( uint64_t jointId64, uint32_t userData )
{
	b3Joint_SetUserData( b3LoadJointId( jointId64 ), b3js_U32ToPtr( userData ) );
}

uint32_t b3js_Joint_GetUserData( uint64_t jointId64 )
{
	return b3js_PtrToU32( b3Joint_GetUserData( b3LoadJointId( jointId64 ) ) );
}

// =================================================================================================
// Weld joint
// =================================================================================================

uint64_t b3js_CreateWeldJoint( uint64_t worldId64, uint64_t bodyA64, uint64_t bodyB64, float faPx, float faPy,
								float faPz, float faQx, float faQy, float faQz, float faQw, float fbPx, float fbPy,
								float fbPz, float fbQx, float fbQy, float fbQz, float fbQw, int collideConnected,
								float linearHertz, float angularHertz, float linearDampingRatio,
								float angularDampingRatio, uint32_t userData )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3WeldJointDef def = b3DefaultWeldJointDef();
	def.base.bodyIdA = b3LoadBodyId( bodyA64 );
	def.base.bodyIdB = b3LoadBodyId( bodyB64 );
	def.base.localFrameA = b3js_Frame( faPx, faPy, faPz, faQx, faQy, faQz, faQw );
	def.base.localFrameB = b3js_Frame( fbPx, fbPy, fbPz, fbQx, fbQy, fbQz, fbQw );
	def.base.collideConnected = collideConnected != 0;
	def.base.userData = b3js_U32ToPtr( userData );
	def.linearHertz = linearHertz;
	def.angularHertz = angularHertz;
	def.linearDampingRatio = linearDampingRatio;
	def.angularDampingRatio = angularDampingRatio;

	b3JointId jointId = b3CreateWeldJoint( worldId, &def );
	return b3StoreJointId( jointId );
}

void b3js_WeldJoint_SetLinearHertz( uint64_t jointId64, float hertz )
{
	b3WeldJoint_SetLinearHertz( b3LoadJointId( jointId64 ), hertz );
}

void b3js_WeldJoint_SetAngularHertz( uint64_t jointId64, float hertz )
{
	b3WeldJoint_SetAngularHertz( b3LoadJointId( jointId64 ), hertz );
}

void b3js_WeldJoint_SetLinearDampingRatio( uint64_t jointId64, float dampingRatio )
{
	b3WeldJoint_SetLinearDampingRatio( b3LoadJointId( jointId64 ), dampingRatio );
}

void b3js_WeldJoint_SetAngularDampingRatio( uint64_t jointId64, float dampingRatio )
{
	b3WeldJoint_SetAngularDampingRatio( b3LoadJointId( jointId64 ), dampingRatio );
}

// =================================================================================================
// Wheel joint. Body A is the chassis, body B is the wheel. The wheel spins about local frame B's
// z-axis and (optionally) translates/suspends along local frame A's x-axis -- see
// vendor/box3d/include/box3d/types.h's b3WheelJointDef doc comment.
// =================================================================================================

uint64_t b3js_CreateWheelJoint( uint64_t worldId64, uint64_t bodyChassis64, uint64_t bodyWheel64, float faPx,
								 float faPy, float faPz, float faQx, float faQy, float faQz, float faQw, float fbPx,
								 float fbPy, float fbPz, float fbQx, float fbQy, float fbQz, float fbQw,
								 int collideConnected, int enableSuspensionSpring, float suspensionHertz,
								 float suspensionDampingRatio, int enableSuspensionLimit, float lowerSuspensionLimit,
								 float upperSuspensionLimit, int enableSpinMotor, float maxSpinTorque, float spinSpeed,
								 int enableSteering, float steeringHertz, float steeringDampingRatio,
								 float targetSteeringAngle, float maxSteeringTorque, int enableSteeringLimit,
								 float lowerSteeringLimit, float upperSteeringLimit, uint32_t userData )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3WheelJointDef def = b3DefaultWheelJointDef();
	def.base.bodyIdA = b3LoadBodyId( bodyChassis64 );
	def.base.bodyIdB = b3LoadBodyId( bodyWheel64 );
	def.base.localFrameA = b3js_Frame( faPx, faPy, faPz, faQx, faQy, faQz, faQw );
	def.base.localFrameB = b3js_Frame( fbPx, fbPy, fbPz, fbQx, fbQy, fbQz, fbQw );
	def.base.collideConnected = collideConnected != 0;
	def.base.userData = b3js_U32ToPtr( userData );

	def.enableSuspensionSpring = enableSuspensionSpring != 0;
	def.suspensionHertz = suspensionHertz;
	def.suspensionDampingRatio = suspensionDampingRatio;
	def.enableSuspensionLimit = enableSuspensionLimit != 0;
	def.lowerSuspensionLimit = lowerSuspensionLimit;
	def.upperSuspensionLimit = upperSuspensionLimit;

	def.enableSpinMotor = enableSpinMotor != 0;
	def.maxSpinTorque = maxSpinTorque;
	def.spinSpeed = spinSpeed;

	def.enableSteering = enableSteering != 0;
	def.steeringHertz = steeringHertz;
	def.steeringDampingRatio = steeringDampingRatio;
	def.targetSteeringAngle = targetSteeringAngle;
	def.maxSteeringTorque = maxSteeringTorque;
	def.enableSteeringLimit = enableSteeringLimit != 0;
	def.lowerSteeringLimit = lowerSteeringLimit;
	def.upperSteeringLimit = upperSteeringLimit;

	b3JointId jointId = b3CreateWheelJoint( worldId, &def );
	return b3StoreJointId( jointId );
}

void b3js_WheelJoint_EnableSuspension( uint64_t jointId64, int flag )
{
	b3WheelJoint_EnableSuspension( b3LoadJointId( jointId64 ), flag != 0 );
}

void b3js_WheelJoint_SetSuspensionLimits( uint64_t jointId64, float lower, float upper )
{
	b3WheelJoint_SetSuspensionLimits( b3LoadJointId( jointId64 ), lower, upper );
}

void b3js_WheelJoint_EnableSpinMotor( uint64_t jointId64, int flag )
{
	b3WheelJoint_EnableSpinMotor( b3LoadJointId( jointId64 ), flag != 0 );
}

void b3js_WheelJoint_SetSpinMotorSpeed( uint64_t jointId64, float speed )
{
	b3WheelJoint_SetSpinMotorSpeed( b3LoadJointId( jointId64 ), speed );
}

void b3js_WheelJoint_SetMaxSpinTorque( uint64_t jointId64, float torque )
{
	b3WheelJoint_SetMaxSpinTorque( b3LoadJointId( jointId64 ), torque );
}

float b3js_WheelJoint_GetSpinSpeed( uint64_t jointId64 )
{
	return b3WheelJoint_GetSpinSpeed( b3LoadJointId( jointId64 ) );
}

float b3js_WheelJoint_GetSpinTorque( uint64_t jointId64 )
{
	return b3WheelJoint_GetSpinTorque( b3LoadJointId( jointId64 ) );
}

void b3js_WheelJoint_EnableSteering( uint64_t jointId64, int flag )
{
	b3WheelJoint_EnableSteering( b3LoadJointId( jointId64 ), flag != 0 );
}

void b3js_WheelJoint_SetTargetSteeringAngle( uint64_t jointId64, float radians )
{
	b3WheelJoint_SetTargetSteeringAngle( b3LoadJointId( jointId64 ), radians );
}

void b3js_WheelJoint_SetMaxSteeringTorque( uint64_t jointId64, float torque )
{
	b3WheelJoint_SetMaxSteeringTorque( b3LoadJointId( jointId64 ), torque );
}

void b3js_WheelJoint_SetSteeringLimits( uint64_t jointId64, float lower, float upper )
{
	b3WheelJoint_SetSteeringLimits( b3LoadJointId( jointId64 ), lower, upper );
}

float b3js_WheelJoint_GetSteeringAngle( uint64_t jointId64 )
{
	return b3WheelJoint_GetSteeringAngle( b3LoadJointId( jointId64 ) );
}

// =================================================================================================
// Revolute joint
// =================================================================================================

uint64_t b3js_CreateRevoluteJoint( uint64_t worldId64, uint64_t bodyA64, uint64_t bodyB64, float faPx, float faPy,
									float faPz, float faQx, float faQy, float faQz, float faQw, float fbPx, float fbPy,
									float fbPz, float fbQx, float fbQy, float fbQz, float fbQw, int collideConnected,
									float targetAngle, int enableSpring, float hertz, float dampingRatio,
									int enableLimit, float lowerAngle, float upperAngle, int enableMotor,
									float maxMotorTorque, float motorSpeed, uint32_t userData )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3RevoluteJointDef def = b3DefaultRevoluteJointDef();
	def.base.bodyIdA = b3LoadBodyId( bodyA64 );
	def.base.bodyIdB = b3LoadBodyId( bodyB64 );
	def.base.localFrameA = b3js_Frame( faPx, faPy, faPz, faQx, faQy, faQz, faQw );
	def.base.localFrameB = b3js_Frame( fbPx, fbPy, fbPz, fbQx, fbQy, fbQz, fbQw );
	def.base.collideConnected = collideConnected != 0;
	def.base.userData = b3js_U32ToPtr( userData );

	def.targetAngle = targetAngle;
	def.enableSpring = enableSpring != 0;
	def.hertz = hertz;
	def.dampingRatio = dampingRatio;
	def.enableLimit = enableLimit != 0;
	def.lowerAngle = lowerAngle;
	def.upperAngle = upperAngle;
	def.enableMotor = enableMotor != 0;
	def.maxMotorTorque = maxMotorTorque;
	def.motorSpeed = motorSpeed;

	b3JointId jointId = b3CreateRevoluteJoint( worldId, &def );
	return b3StoreJointId( jointId );
}

void b3js_RevoluteJoint_EnableMotor( uint64_t jointId64, int flag )
{
	b3RevoluteJoint_EnableMotor( b3LoadJointId( jointId64 ), flag != 0 );
}

void b3js_RevoluteJoint_SetMotorSpeed( uint64_t jointId64, float speed )
{
	b3RevoluteJoint_SetMotorSpeed( b3LoadJointId( jointId64 ), speed );
}

void b3js_RevoluteJoint_SetMaxMotorTorque( uint64_t jointId64, float torque )
{
	b3RevoluteJoint_SetMaxMotorTorque( b3LoadJointId( jointId64 ), torque );
}

float b3js_RevoluteJoint_GetAngle( uint64_t jointId64 )
{
	return b3RevoluteJoint_GetAngle( b3LoadJointId( jointId64 ) );
}

// =================================================================================================
// Distance joint
// =================================================================================================

uint64_t b3js_CreateDistanceJoint( uint64_t worldId64, uint64_t bodyA64, uint64_t bodyB64, float faPx, float faPy,
									float faPz, float faQx, float faQy, float faQz, float faQw, float fbPx, float fbPy,
									float fbPz, float fbQx, float fbQy, float fbQz, float fbQw, int collideConnected,
									float length, int enableSpring, float lowerSpringForce, float upperSpringForce,
									float hertz, float dampingRatio, int enableLimit, float minLength,
									float maxLength, int enableMotor, float maxMotorForce, float motorSpeed,
									uint32_t userData )
{
	b3WorldId worldId = b3js_UnpackWorldId( worldId64 );
	b3DistanceJointDef def = b3DefaultDistanceJointDef();
	def.base.bodyIdA = b3LoadBodyId( bodyA64 );
	def.base.bodyIdB = b3LoadBodyId( bodyB64 );
	def.base.localFrameA = b3js_Frame( faPx, faPy, faPz, faQx, faQy, faQz, faQw );
	def.base.localFrameB = b3js_Frame( fbPx, fbPy, fbPz, fbQx, fbQy, fbQz, fbQw );
	def.base.collideConnected = collideConnected != 0;
	def.base.userData = b3js_U32ToPtr( userData );

	def.length = length;
	def.enableSpring = enableSpring != 0;
	def.lowerSpringForce = lowerSpringForce;
	def.upperSpringForce = upperSpringForce;
	def.hertz = hertz;
	def.dampingRatio = dampingRatio;
	def.enableLimit = enableLimit != 0;
	def.minLength = minLength;
	def.maxLength = maxLength;
	def.enableMotor = enableMotor != 0;
	def.maxMotorForce = maxMotorForce;
	def.motorSpeed = motorSpeed;

	b3JointId jointId = b3CreateDistanceJoint( worldId, &def );
	return b3StoreJointId( jointId );
}

void b3js_DistanceJoint_SetLength( uint64_t jointId64, float length )
{
	b3DistanceJoint_SetLength( b3LoadJointId( jointId64 ), length );
}

void b3js_DistanceJoint_EnableMotor( uint64_t jointId64, int flag )
{
	b3DistanceJoint_EnableMotor( b3LoadJointId( jointId64 ), flag != 0 );
}

void b3js_DistanceJoint_SetMotorSpeed( uint64_t jointId64, float speed )
{
	b3DistanceJoint_SetMotorSpeed( b3LoadJointId( jointId64 ), speed );
}

float b3js_DistanceJoint_GetCurrentLength( uint64_t jointId64 )
{
	return b3DistanceJoint_GetCurrentLength( b3LoadJointId( jointId64 ) );
}
