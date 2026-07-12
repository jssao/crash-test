// SPDX-License-Identifier: MIT
//
// Right-side controls panel for the Model Viewer: render mode (shaded/wireframe/normals), display
// toggles (auto-rotate, grid, bounding box, ground, environment), camera preset views + reset, and a
// turntable-speed slider. Pure DOM (same plain-DOM approach as ui.ts). It owns no viewer state — it
// fires callbacks and exposes setters so the keyboard shortcuts in main.ts can keep the buttons/
// checkboxes visually in sync with state changed from the keyboard.

import type { RenderMode } from './rendermodes';
import type { CameraPreset } from './orbit';

export type ToggleKey = 'autorotate' | 'grid' | 'bbox' | 'ground' | 'env';

export interface ViewerControlsCallbacks {
  onRenderMode(mode: RenderMode): void;
  onToggle(key: ToggleKey, value: boolean): void;
  onPreset(preset: CameraPreset): void;
  onReset(): void;
  onSpinRate(rate: number): void;
}

export interface ViewerControls {
  /** Reflect a render-mode change made elsewhere (keyboard) in the segmented buttons. */
  setRenderMode(mode: RenderMode): void;
  /** Reflect a toggle change made elsewhere (keyboard) in the checkbox. */
  setToggle(key: ToggleKey, value: boolean): void;
}

const STYLE = `
.mvc { position: absolute; top: 0; right: 0; width: 214px; pointer-events: auto;
  background: rgba(12,15,19,0.82); backdrop-filter: blur(8px);
  border-left: 1px solid rgba(255,255,255,0.08); color: #dfe8f0; overflow-y: auto; bottom: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.mvc::-webkit-scrollbar { width: 8px; }
.mvc::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 4px; }
.mvc-sec { padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.mvc-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; color: #6f8398;
  font-weight: 600; margin-bottom: 8px; }
.mvc-seg { display: flex; gap: 4px; }
.mvc-btn { flex: 1; text-align: center; padding: 6px 4px; font-size: 12px; color: #c3d2e0;
  background: rgba(255,255,255,0.05); border: 1px solid transparent; border-radius: 6px; cursor: pointer;
  user-select: none; }
.mvc-btn:hover { background: rgba(255,255,255,0.09); color: #eaf4ff; }
.mvc-btn.mvc-on { background: rgba(79,168,255,0.20); color: #eaf4ff; border-color: #4fa8ff; }
.mvc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.mvc-chk { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #c3d2e0;
  padding: 5px 0; cursor: pointer; }
.mvc-chk input { accent-color: #4fa8ff; width: 14px; height: 14px; cursor: pointer; }
.mvc-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.mvc-val { font-size: 11px; color: #8fa6bd; font-variant-numeric: tabular-nums; }
.mvc-range { width: 100%; accent-color: #4fa8ff; }
`;

export function createViewerControls(root: HTMLElement, cb: ViewerControlsCallbacks): ViewerControls {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'mvc';

  // ---- Render mode (segmented) ----------------------------------------------------------------
  const modeBtns: Record<RenderMode, HTMLElement> = {} as Record<RenderMode, HTMLElement>;
  const modeSec = section('Render');
  const seg = document.createElement('div');
  seg.className = 'mvc-seg';
  ([['shaded', 'Shaded'], ['wireframe', 'Wire'], ['normals', 'Normals']] as [RenderMode, string][]).forEach(([mode, label]) => {
    const b = document.createElement('div');
    b.className = 'mvc-btn' + (mode === 'shaded' ? ' mvc-on' : '');
    b.textContent = label;
    b.addEventListener('click', () => cb.onRenderMode(mode));
    modeBtns[mode] = b;
    seg.appendChild(b);
  });
  modeSec.appendChild(seg);

  // ---- Display toggles ------------------------------------------------------------------------
  const toggleInputs: Record<ToggleKey, HTMLInputElement> = {} as Record<ToggleKey, HTMLInputElement>;
  const dispSec = section('Display');
  const toggleDefs: [ToggleKey, string, boolean][] = [
    ['autorotate', 'Auto-rotate', true],
    ['grid', 'Grid (1 m)', false],
    ['bbox', 'Bounding box', false],
    ['ground', 'Ground', true],
    ['env', 'Environment', true],
  ];
  for (const [key, label, def] of toggleDefs) {
    const row = document.createElement('label');
    row.className = 'mvc-chk';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = def;
    input.addEventListener('change', () => cb.onToggle(key, input.checked));
    const span = document.createElement('span');
    span.textContent = label;
    row.appendChild(input);
    row.appendChild(span);
    dispSec.appendChild(row);
    toggleInputs[key] = input;
  }

  // ---- Camera views ---------------------------------------------------------------------------
  const viewSec = section('View');
  const grid = document.createElement('div');
  grid.className = 'mvc-grid';
  ([['front', 'Front'], ['back', 'Back'], ['top', 'Top'], ['left', 'Left'], ['right', 'Right'], ['iso', '3/4']] as [CameraPreset, string][]).forEach(
    ([preset, label]) => {
      const b = document.createElement('div');
      b.className = 'mvc-btn';
      b.textContent = label;
      b.addEventListener('click', () => cb.onPreset(preset));
      grid.appendChild(b);
    },
  );
  viewSec.appendChild(grid);
  const resetBtn = document.createElement('div');
  resetBtn.className = 'mvc-btn';
  resetBtn.style.marginTop = '4px';
  resetBtn.textContent = 'Reset view (R)';
  resetBtn.addEventListener('click', () => cb.onReset());
  viewSec.appendChild(resetBtn);

  // ---- Turntable speed ------------------------------------------------------------------------
  const spinSec = section('Turntable');
  const row = document.createElement('div');
  row.className = 'mvc-row';
  const lab = document.createElement('div');
  lab.className = 'mvc-h';
  lab.style.margin = '0';
  lab.textContent = 'Speed';
  const val = document.createElement('div');
  val.className = 'mvc-val';
  val.textContent = '0.28';
  row.appendChild(lab);
  row.appendChild(val);
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'mvc-range';
  range.min = '0';
  range.max = '1.5';
  range.step = '0.02';
  range.value = '0.28';
  range.addEventListener('input', () => {
    val.textContent = Number(range.value).toFixed(2);
    cb.onSpinRate(Number(range.value));
  });
  spinSec.appendChild(row);
  spinSec.appendChild(range);

  panel.appendChild(modeSec);
  panel.appendChild(dispSec);
  panel.appendChild(viewSec);
  panel.appendChild(spinSec);
  root.appendChild(panel);

  function section(title: string): HTMLElement {
    const s = document.createElement('div');
    s.className = 'mvc-sec';
    const h = document.createElement('div');
    h.className = 'mvc-h';
    h.textContent = title;
    s.appendChild(h);
    return s;
  }

  return {
    setRenderMode(mode) {
      for (const key of Object.keys(modeBtns) as RenderMode[]) {
        modeBtns[key].classList.toggle('mvc-on', key === mode);
      }
    },
    setToggle(key, value) {
      if (toggleInputs[key]) toggleInputs[key].checked = value;
    },
  };
}
