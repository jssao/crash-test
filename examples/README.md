# examples/

Three.js integration demos — the port's proof it works from a real renderer. Empty until built.

Target first demo (BRIEF goal item 3): N boxes drop onto a ground plane and come to rest, with Box3D
stepping the simulation and driving Three.js mesh transforms each frame via a batched `HEAPF32`
transforms read. Must run without console errors; verify headlessly (the Santiago's Wrath render
harness is a working template on this machine).
