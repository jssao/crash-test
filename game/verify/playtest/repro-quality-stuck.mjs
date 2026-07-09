// Focused follow-up: battery.mjs's quality-cycling scenario found window.__GAME__.quality advancing
// high->medium on the first KeyQ press, then getting stuck reporting "medium" for the next 5 presses
// (no console/page errors, wasm/physics engine confirmed still alive afterward). Isolates whether
// that's specific to (a) mid-crash load, (b) interleaving stepN() between presses, or a real bug in
// the antialias-triggering renderer-swap path (medium->low flips antialias true->false).
import { launchHarness, sleep, writeJson } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4555, cdpPort: 9550, width: 1280, height: 720, label: 'repro-quality' });
  const { evalExpr } = h;
  async function pressKey(code, key) {
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key });
  }
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await pressKey('KeyQ', 'q');
    await sleep(600); // generous real-time gap, no stepN() interleaving at all -- pure idle + real rAF
    const level = await evalExpr('window.__GAME__.quality');
    const rendererInfo = await evalExpr(`(() => { const r = window.__GAME__.renderer; return { contextLost: r.getContext().isContextLost(), antialias: r.getContextAttributes().antialias }; })()`);
    seen.push({ press: i + 1, level, rendererInfo });
    console.log(`press ${i + 1}: quality=${level}`, JSON.stringify(rendererInfo));
  }
  const stillAlive = await evalExpr('window.__GAME__.stepN(5); "still alive"').catch((e) => `DEAD: ${e.message}`);
  console.log('post-test stepN check:', stillAlive);
  console.log('console errors:', h.consoleErrors.length, JSON.stringify(h.consoleErrors));
  console.log('page errors:', h.pageErrors.length, JSON.stringify(h.pageErrors));
  writeJson('repro-quality-stuck-result.json', { seen, stillAlive, consoleErrors: h.consoleErrors, pageErrors: h.pageErrors });
  await h.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[repro-quality] FATAL', err);
  process.exit(1);
});
