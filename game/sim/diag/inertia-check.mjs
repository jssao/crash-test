import { init, World, BodyType } from "/Users/jesuscalderon/Documents/crash test/dist/index.js";

const native = await init({
  wasmUrl: new URL("file:///Users/jesuscalderon/Documents/crash%20test/build/wasm/box3d.mjs"),
});
const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
const chassis = world.createBody({ type: BodyType.Dynamic, position: { x: 0, y: 1, z: 0 } });

// Mirror vehicle.ts's chassis shapes approximately: hull box + off-center sensor ballast sphere.
chassis.createBoxShape({ halfExtents: { x: 0.95, y: 0.6, z: 2.2 } }, { density: 250 });
const ballast = chassis.createSphereShape({ radius: 0.3, center: { x: 0, y: -0.34, z: 0 }, density: 3000, isSensor: true });
chassis.applyMassFromShapes();

const md = chassis.getMassData();
console.log("mass", md.mass);
console.log("center (local COM)", md.center);
console.log("inertia diag", md.inertia.cx.x, md.inertia.cy.y, md.inertia.cz.z);
console.log("inertia off-diag", md.inertia.cx.y, md.inertia.cx.z, md.inertia.cy.z);

// Now prove setMassData is live: override with a synthetic MassData and read it back.
chassis.setMassData({
  mass: 1000,
  center: { x: 0, y: -0.25, z: 0 },
  inertia: { cx: { x: 500, y: 0, z: 0 }, cy: { x: 0, y: 600, z: 0 }, cz: { x: 0, y: 0, z: 700 } },
});
const md2 = chassis.getMassData();
console.log("after setMassData -> mass", md2.mass, "center", md2.center, "diag", md2.inertia.cx.x, md2.inertia.cy.y, md2.inertia.cz.z);

world.destroy();
