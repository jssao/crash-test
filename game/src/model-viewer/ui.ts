// SPDX-License-Identifier: MIT
//
// Left sidebar for the Model Viewer: a filterable, category-grouped list of every catalog model, with
// a footer info/stats card for the selected one. Built entirely in JS (same paints-instantly-plain-DOM
// philosophy the game's HUD uses) under the #ui overlay from model-viewer.html. The overlay itself is
// pointer-events:none; only the interactive panels opt back into pointer-events:auto so orbit-drags
// over empty canvas still reach the renderer.

import type { ModelEntry } from './types';

export interface ViewerUI {
  /** Populate (or replace) the list. Called once at boot. */
  setEntries(entries: ModelEntry[]): void;
  onSelect(cb: (index: number) => void): void;
  /** Highlight + scroll to a row and refresh the info card (does NOT fire the onSelect callback). */
  select(index: number): void;
}

const STYLE = `
.mv-panel { position: absolute; pointer-events: auto; color: #dfe8f0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.mv-list { top: 0; left: 0; bottom: 0; width: 264px; background: rgba(12,15,19,0.82);
  backdrop-filter: blur(8px); border-right: 1px solid rgba(255,255,255,0.08);
  display: flex; flex-direction: column; }
.mv-list-head { padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.07); }
.mv-list-title { font-size: 15px; font-weight: 650; letter-spacing: 0.02em; color: #eaf4ff; }
.mv-list-sub { font-size: 11px; color: #7f93a8; margin-top: 3px; }
.mv-filter { margin: 9px 0 1px; width: 100%; box-sizing: border-box; padding: 6px 9px; font-size: 12px;
  color: #eaf4ff; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; outline: none; font-family: inherit; }
.mv-filter:focus { border-color: #4fa8ff; }
.mv-list-scroll { flex: 1; overflow-y: auto; padding: 6px 0 10px; }
.mv-list-scroll::-webkit-scrollbar { width: 8px; }
.mv-list-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 4px; }
.mv-cat { font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; color: #6f8398;
  padding: 12px 16px 5px; font-weight: 600; }
.mv-row { padding: 7px 16px; font-size: 13px; color: #c3d2e0; cursor: pointer; line-height: 1.25;
  border-left: 2px solid transparent; }
.mv-row:hover { background: rgba(255,255,255,0.05); color: #eaf4ff; }
.mv-row.mv-active { background: rgba(79,168,255,0.16); color: #eaf4ff; border-left-color: #4fa8ff; }
.mv-empty { padding: 14px 16px; font-size: 12px; color: #6f8398; }
.mv-foot { padding: 12px 16px 14px; border-top: 1px solid rgba(255,255,255,0.09);
  background: rgba(0,0,0,0.18); }
.mv-foot-label { font-size: 14px; font-weight: 650; color: #eaf4ff; }
.mv-foot-cat { font-size: 10px; color: #4fa8ff; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.06em; }
.mv-foot-dims { font-size: 12px; color: #9fb2c6; margin-top: 8px; font-variant-numeric: tabular-nums; }
.mv-foot-stats { font-size: 11px; color: #8fa6bd; margin-top: 5px; font-variant-numeric: tabular-nums; line-height: 1.5; }
.mv-foot-note { font-size: 11px; color: #6f8398; margin-top: 5px; }
`;

const fmt = (n: number): string => n.toLocaleString('en-US');

export function createViewerUI(root: HTMLElement): ViewerUI {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const list = document.createElement('div');
  list.className = 'mv-panel mv-list';
  list.innerHTML = `
    <div class="mv-list-head">
      <div class="mv-list-title">Model Viewer</div>
      <div class="mv-list-sub" id="mv-count"></div>
      <input class="mv-filter" id="mv-filter" type="text" placeholder="Filter models…" spellcheck="false" />
    </div>
    <div class="mv-list-scroll" id="mv-scroll"></div>
    <div class="mv-foot">
      <div class="mv-foot-label" id="mv-foot-label">—</div>
      <div class="mv-foot-cat" id="mv-foot-cat"></div>
      <div class="mv-foot-dims" id="mv-foot-dims"></div>
      <div class="mv-foot-stats" id="mv-foot-stats"></div>
      <div class="mv-foot-note" id="mv-foot-note"></div>
    </div>`;
  root.appendChild(list);

  const scroll = list.querySelector('#mv-scroll') as HTMLElement;
  const countEl = list.querySelector('#mv-count') as HTMLElement;
  const filterEl = list.querySelector('#mv-filter') as HTMLInputElement;

  let selectCb: (index: number) => void = () => {};
  let entries: ModelEntry[] = [];
  let rowEls: HTMLElement[] = []; // sparse, indexed by ORIGINAL entry index
  let activeIndex = -1;
  let filter = '';

  function render(): void {
    scroll.innerHTML = '';
    rowEls = [];
    const q = filter.trim().toLowerCase();
    let shown = 0;
    let lastCat: string | null = null;

    entries.forEach((entry, index) => {
      if (q && !entry.label.toLowerCase().includes(q) && !entry.category.toLowerCase().includes(q)) return;
      shown++;
      if (entry.category !== lastCat) {
        const cat = document.createElement('div');
        cat.className = 'mv-cat';
        cat.textContent = entry.category;
        scroll.appendChild(cat);
        lastCat = entry.category;
      }
      const row = document.createElement('div');
      row.className = 'mv-row' + (index === activeIndex ? ' mv-active' : '');
      row.textContent = entry.label;
      row.addEventListener('click', () => selectCb(index));
      scroll.appendChild(row);
      rowEls[index] = row;
    });

    if (shown === 0) {
      const empty = document.createElement('div');
      empty.className = 'mv-empty';
      empty.textContent = 'No models match.';
      scroll.appendChild(empty);
    }
    countEl.textContent = q ? `${shown} of ${entries.length} models` : `${entries.length} models`;
  }

  function select(index: number): void {
    if (index < 0 || index >= entries.length) return;
    if (activeIndex >= 0 && rowEls[activeIndex]) rowEls[activeIndex].classList.remove('mv-active');
    activeIndex = index;
    const row = rowEls[index];
    const entry = entries[index];
    if (row) {
      row.classList.add('mv-active');
      row.scrollIntoView({ block: 'nearest' });
    }
    (list.querySelector('#mv-foot-label') as HTMLElement).textContent = entry.label;
    (list.querySelector('#mv-foot-cat') as HTMLElement).textContent = entry.category;
    (list.querySelector('#mv-foot-dims') as HTMLElement).textContent = entry.dims ?? '';
    const s = entry.stats;
    (list.querySelector('#mv-foot-stats') as HTMLElement).textContent = s
      ? `▲ ${fmt(s.triangles)} tris · ${fmt(s.vertices)} verts\n${s.meshes} mesh · ${s.materials} material${s.materials === 1 ? '' : 's'}`
      : '';
    (list.querySelector('#mv-foot-note') as HTMLElement).textContent = entry.note ?? '';
  }

  filterEl.addEventListener('input', () => {
    filter = filterEl.value;
    render();
    if (activeIndex >= 0) select(activeIndex); // keep the footer + highlight in sync after re-render
  });

  return {
    setEntries(e) {
      entries = e;
      render();
    },
    onSelect(cb) {
      selectCb = cb;
    },
    select,
  };
}
