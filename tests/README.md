# tests/

Binding + determinism tests. Empty until built.

Target tests (BRIEF goal items 2 & 4):
- **gravity drop / ground rest** — a dynamic body falls under gravity and stabilizes on a static
  ground (y decreases then holds steady).
- **memory stability** — a create→destroy loop over worlds/bodies/shapes/joints does not grow wasm
  linear memory unboundedly (lifecycles are owned by the TS wrapper).
