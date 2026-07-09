# Deploy handoff -- box3d-js crash sandbox

Everything needed to publish is committed. This machine has **no GitHub credentials** (no `gh`
CLI, no SSH key, no token) and **no git remote configured** -- so this repo could not be pushed or
have a GitHub repo created for it as part of this prep. The two commands below do that.

## 1. Publish the repo

```sh
brew install gh && gh auth login
gh repo create box3d-js --public --source=. --push
```

**Must be `--public`.** GitHub Pages via GitHub Actions requires a public repo on free
(non-Enterprise) plans -- a private repo will not have Pages available to enable.

## 2. Enable GitHub Pages

The workflow at `.github/workflows/deploy.yml` will run automatically on the push above (it
triggers on `push` to `main`), but Pages needs to be pointed at "GitHub Actions" as its source
once, first:

- Go to the repo on github.com -> **Settings** -> **Pages**.
- Under "Build and deployment" -> **Source**, choose **GitHub Actions** (not "Deploy from a
  branch").

That's it -- no branch, no `gh-pages`, no manual artifact upload. Every future push to `main` will
redeploy automatically. If `gh api` is available and you'd rather not click through the UI, the
one-liner is:

```sh
gh api -X POST repos/<your-user>/box3d-js/pages -f build_type=workflow
```

(Not verified from this machine -- no `gh`/network access here. If it errors, use the Settings UI
above; it always works.)

## 3. Expected result

- **URL:** `https://<your-user>.github.io/box3d-js/`
- **First deploy:** takes about 2 minutes. Watch it under the repo's **Actions** tab -- two jobs
  run in sequence, `test` (root `npx vitest run`, 6 tests) then `deploy` (builds `game/`, uploads
  `game/dist`, publishes to Pages). Green checks on both = live.

### Troubleshooting

- **Nothing under the Actions tab:** the workflow only triggers on push to `main` or manual
  dispatch. Use the "Run workflow" button on the `Deploy` workflow page to trigger it by hand if
  needed.
- **`test` job fails:** should not happen -- the wasm artifacts (`build/wasm/box3d.mjs`,
  `build/wasm/box3d.wasm`) are committed specifically so CI never needs emscripten. If it does
  fail, it's almost certainly unrelated to the wasm build (see the job log).
- **`deploy` job fails on "upload-pages-artifact" or "deploy-pages":** almost always means Pages
  isn't set to "GitHub Actions" as its source yet -- go do step 2 above, then re-run the workflow
  from the Actions tab.
- **Page loads blank / 404s on assets:** hard-refresh (the `base: './'` Vite config is
  subpath-safe, but browser caches from a previous attempt can stick around).

## Play locally, right now

The game already runs without any of the above -- no GitHub account, no deploy needed:

```sh
cd game
npm install   # first time only
npm run dev
```

Opens on `http://localhost:5173`. (The wasm binary is pre-built and checked in at
`build/wasm/box3d.wasm`; no emscripten toolchain required to just play.)

## How to play

| Key | Action |
| --- | --- |
| `W A S D` | Drive |
| `Space` | Handbrake |
| `R` | Repair car |
| `Shift + R` | Repair car + reset the destructible world (boxes, barrels, crates) |
| `C` | Toggle chase / orbit camera |
| `Q` | Cycle render quality preset |
| `F` | Toggle perf/FPS overlay |
| `?` | Toggle the on-screen controls card |

Drive into the crates, barrels, and stacked props scattered around the sandbox -- everything is a
dynamic rigid body simulated by the Box3D wasm physics core in `../src/ts` / `../build/wasm`.
