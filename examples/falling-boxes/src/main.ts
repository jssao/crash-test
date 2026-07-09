// box3d-js example: ~50 falling boxes onto a static ground box.
//
// Demonstrates the REQUIRED batched-transform render path: every fixed physics step, mesh poses
// are synced from World.moveEvents() -- a zero-allocation cursor over a flat HEAPF32 buffer (see
// src/ts/events.ts) -- never via per-body Body.getTransform()/getPosition() calls in the render
// loop. Per-body queries are reserved for one-off introspection (see bodyYs() below, which is
// called on demand by the headless verifier, not every frame).
//
// Run `scripts/build-wasm.sh` from the repo root first (see this example's README.md) -- this app
// consumes the binding's TS sources directly (../../../src/ts/index.js) and loads the compiled
// build/wasm/box3d.{mjs,wasm} that script produces (copied into public/wasm/ by
// scripts/copy-wasm.mjs, wired as the predev/prebuild npm hook).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { init, World, BodyType, type Vec3, type Quat } from "../../../src/ts/index.js";

const BOX_COUNT = 50;
const FIXED_DT = 1 / 60;
const GROUND_HALF_EXTENT = 15;

// ---- per-instance simulation-side state, kept in sync purely from moveEvents ----
interface BoxState {
	position: Vec3;
	rotation: Quat;
	scale: number;
	awake: boolean;
	speed: number; // finite-differenced |dPosition/dt|, m/s -- derived from moveEvents, not a native call
}

function randRange( lo: number, hi: number ): number {
	return lo + Math.random() * ( hi - lo );
}

function randomQuat(): Quat {
	const e = new THREE.Euler( randRange( 0, Math.PI * 2 ), randRange( 0, Math.PI * 2 ), randRange( 0, Math.PI * 2 ) );
	const q = new THREE.Quaternion().setFromEuler( e );
	return { x: q.x, y: q.y, z: q.z, w: q.w };
}

async function main() {
	const canvas = document.getElementById( "app" ) as HTMLCanvasElement;
	const hud = document.getElementById( "hud" ) as HTMLDivElement;

	// ---- Three.js scene ----
	const renderer = new THREE.WebGLRenderer( { canvas, antialias: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.1;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x1a1d24 );
	scene.fog = new THREE.Fog( 0x1a1d24, 40, 120 );

	const camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 500 );
	camera.position.set( 13, 11, 15 );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0, 0.8, 0 );
	controls.enableDamping = true;
	controls.update();

	const hemi = new THREE.HemisphereLight( 0xbfd9ff, 0x30281f, 0.9 );
	scene.add( hemi );

	const sun = new THREE.DirectionalLight( 0xffffff, 2.4 );
	sun.position.set( 18, 30, 12 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( 2048, 2048 );
	sun.shadow.camera.left = -GROUND_HALF_EXTENT - 5;
	sun.shadow.camera.right = GROUND_HALF_EXTENT + 5;
	sun.shadow.camera.top = GROUND_HALF_EXTENT + 5;
	sun.shadow.camera.bottom = -GROUND_HALF_EXTENT - 5;
	sun.shadow.camera.near = 1;
	sun.shadow.camera.far = 80;
	sun.shadow.bias = -0.0015;
	scene.add( sun );

	const groundMesh = new THREE.Mesh(
		new THREE.BoxGeometry( GROUND_HALF_EXTENT * 2, 1, GROUND_HALF_EXTENT * 2 ),
		new THREE.MeshStandardMaterial( { color: 0x3d4552, roughness: 0.95, metalness: 0.02 } )
	);
	groundMesh.position.set( 0, -0.5, 0 );
	groundMesh.receiveShadow = true;
	scene.add( groundMesh );

	const boxGeometry = new THREE.BoxGeometry( 1, 1, 1 );
	const boxMaterial = new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.5, metalness: 0.1 } );
	const instancedMesh = new THREE.InstancedMesh( boxGeometry, boxMaterial, BOX_COUNT );
	instancedMesh.castShadow = true;
	instancedMesh.receiveShadow = true;
	instancedMesh.instanceColor = new THREE.InstancedBufferAttribute( new Float32Array( BOX_COUNT * 3 ), 3 );
	scene.add( instancedMesh );

	// ---- Physics world ----
	const native = await init( { wasmUrl: new URL( "/wasm/box3d.mjs", window.location.origin ) } );
	const world = new World( native );

	const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } } );
	ground.createBoxShape( { halfExtents: { x: GROUND_HALF_EXTENT, y: 0.5, z: GROUND_HALF_EXTENT } } );

	const states: BoxState[] = [];
	const dummy = new THREE.Object3D();
	const color = new THREE.Color();

	for ( let i = 0; i < BOX_COUNT; i++ ) {
		const scale = randRange( 0.6, 1.3 );
		const halfExtent = 0.5 * scale;
		const startPos: Vec3 = {
			x: randRange( -8, 8 ),
			y: randRange( 4, 14 ),
			z: randRange( -8, 8 ),
		};
		const startRot = randomQuat();

		const body = world.createBody( {
			type: BodyType.Dynamic,
			position: startPos,
			rotation: startRot,
			userData: i + 1, // 0 is reserved (unused/ground); moveEvents.userData maps back to `i`
		} );
		body.createBoxShape( { halfExtents: { x: halfExtent, y: halfExtent, z: halfExtent }, friction: 0.6 } );

		states.push( { position: startPos, rotation: startRot, scale, awake: true, speed: 0 } );

		dummy.position.set( startPos.x, startPos.y, startPos.z );
		dummy.quaternion.set( startRot.x, startRot.y, startRot.z, startRot.w );
		dummy.scale.setScalar( scale );
		dummy.updateMatrix();
		instancedMesh.setMatrixAt( i, dummy.matrix );

		color.setHSL( randRange( 0, 1 ), 0.55, 0.6 );
		instancedMesh.setColorAt( i, color );
	}
	instancedMesh.instanceMatrix.needsUpdate = true;
	if ( instancedMesh.instanceColor ) instancedMesh.instanceColor.needsUpdate = true;

	// ---- window.__sim: exposed for the headless verifier (see verify.mjs) ----
	const sim = {
		time: 0,
		sleepingCount: 0,
		maxAbsVelocity: 0,
		bodyYs(): number[] {
			return states.map( ( s ) => s.position.y );
		},
	};
	( window as unknown as { __sim: typeof sim } ).__sim = sim;

	// ---- fixed-step accumulator loop; mesh sync is 100% driven by world.moveEvents() ----
	let accumulator = 0;
	let lastNow = performance.now();
	let dirty = false;

	function stepPhysics( dt: number ) {
		world.step( dt );
		const events = world.moveEvents();
		for ( let i = 0; i < events.count; i++ ) {
			const e = events.at( i );
			const index = e.userData - 1;
			if ( index < 0 || index >= BOX_COUNT ) continue; // ignore ground / unexpected ids

			const s = states[index];
			const dx = e.position.x - s.position.x;
			const dy = e.position.y - s.position.y;
			const dz = e.position.z - s.position.z;
			s.speed = e.fellAsleep ? 0 : Math.sqrt( dx * dx + dy * dy + dz * dz ) / dt;
			s.position = { x: e.position.x, y: e.position.y, z: e.position.z };
			s.rotation = { x: e.rotation.x, y: e.rotation.y, z: e.rotation.z, w: e.rotation.w };
			s.awake = !e.fellAsleep;

			dummy.position.set( s.position.x, s.position.y, s.position.z );
			dummy.quaternion.set( s.rotation.x, s.rotation.y, s.rotation.z, s.rotation.w );
			dummy.scale.setScalar( s.scale );
			dummy.updateMatrix();
			instancedMesh.setMatrixAt( index, dummy.matrix );
			dirty = true;
		}

		sim.time += dt;
		let sleeping = 0;
		let maxSpeed = 0;
		for ( const s of states ) {
			if ( !s.awake ) sleeping++;
			if ( s.speed > maxSpeed ) maxSpeed = s.speed;
		}
		sim.sleepingCount = sleeping;
		sim.maxAbsVelocity = maxSpeed;
	}

	function animate( now: number ) {
		requestAnimationFrame( animate );
		let frameTime = ( now - lastNow ) / 1000;
		lastNow = now;
		frameTime = Math.min( frameTime, 0.25 ); // clamp the "spiral of death" after a stall

		accumulator += frameTime;
		while ( accumulator >= FIXED_DT ) {
			stepPhysics( FIXED_DT );
			accumulator -= FIXED_DT;
		}

		if ( dirty ) {
			instancedMesh.instanceMatrix.needsUpdate = true;
			dirty = false;
		}

		controls.update();
		renderer.render( scene, camera );

		hud.textContent = `box3d-js falling-boxes\n` +
			`t=${ sim.time.toFixed( 2 ) }s  asleep=${ sim.sleepingCount }/${ BOX_COUNT }  ` +
			`maxV=${ sim.maxAbsVelocity.toFixed( 3 ) } m/s`;
	}

	requestAnimationFrame( animate );

	window.addEventListener( "resize", () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
	} );
}

main().catch( ( err ) => {
	console.error( "falling-boxes example failed to start:", err );
} );
