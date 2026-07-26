import '@xterm/xterm/css/xterm.css';
import './style.css';

import { TerminalPane, clampFont, type PaneHost } from './pane';
import {
  findLeaf, insertBeside, leaf, leaves, normalized, removeLeaf,
  type Branch, type Direction, type LayoutNode,
} from './layout';

/** Nothing about the layout is stored: every page starts at one console. */
const DEFAULT_FONT = 14;
/** Smallest useful console, measured along the axis its branch splits on. */
const MIN: Record<Direction, number> = { row: 220, column: 90 };
/** How far an arrow key moves a splitter. */
const NUDGE = 24;

const stageEl = document.querySelector<HTMLElement>('#stage')!;
const toastEl = document.querySelector<HTMLDivElement>('#toast')!;
const footerEl = document.querySelector<HTMLElement>('#footer')!;
const headerEl = document.querySelector<HTMLElement>('#header')!;

/** The name this app is listed under, and package.json's `homepage`. Both are
 *  baked in by Vite at build time. */
declare const __TITLE__: string;
declare const __HOMEPAGE__: string;

/** The whole split tree is on screen at once, with a splitter at every seam. */
class Console implements PaneHost {
  private root: LayoutNode | null = null;
  private active: TerminalPane | null = null;
  private fontSize = DEFAULT_FONT;
  private toastTimer: number | undefined;
  private refitQueued = false;

  /* ---- PaneHost ---- */

  isActive(pane: TerminalPane): boolean {
    return this.active === pane;
  }

  fallbackLabel(pane: TerminalPane): string {
    return pane.id ? `shell ${this.panes().indexOf(pane) + 1}` : 'connecting…';
  }

  requestSplit(pane: TerminalPane, dir: Direction): void {
    this.activate(pane);
    this.split(dir);
  }

  /** The size a pane's A+/A- settles on becomes the default for the next pane
   *  in this page, and is forgotten when it is closed. */
  rememberFontSize(size: number): void {
    this.fontSize = clampFont(size);
  }

  activate(pane: TerminalPane): void {
    if (this.active === pane) return;
    this.active = pane;
    for (const other of this.panes()) other.render();
    pane.focus();
  }

  requestClose(pane: TerminalPane): void {
    if (!this.root || !findLeaf(this.root, pane)) return;
    const index = this.panes().indexOf(pane);
    pane.dispose();
    this.root = removeLeaf(this.root, pane);
    if (this.active === pane) this.active = null;

    if (!this.root) {
      // Nothing left to split; `split` plants a fresh console instead.
      this.split('row');
      return;
    }
    this.draw();
    if (!this.active) {
      const rest = this.panes();
      this.activate(rest[Math.min(index, rest.length - 1)]!);
    }
    this.refit();
  }

  toast(message: string): void {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  /* ---- the tree ---- */

  /** Splits the focused console: `row` puts the new one beside it, `column` below. */
  split(dir: Direction): void {
    const target = this.active;
    const added = new TerminalPane(this, null, this.fontSize);
    this.root = target && this.root ? insertBeside(this.root, target, dir, added) : leaf(added);
    this.draw();
    this.activate(added);
    this.refit();
  }

  closeActive(): void {
    if (this.active) this.requestClose(this.active);
  }

  /** Moves the focus to the nearest console in a direction. */
  navigate(dx: number, dy: number): void {
    if (!this.active) return;
    const from = centre(this.active);
    let best: { pane: TerminalPane; score: number } | null = null;
    for (const pane of this.panes()) {
      if (pane === this.active) continue;
      const to = centre(pane);
      const ahead = (to.x - from.x) * dx + (to.y - from.y) * dy;
      if (ahead <= 1) continue;
      const aside = Math.abs((to.x - from.x) * dy + (to.y - from.y) * dx);
      const score = ahead + aside * 2;
      if (!best || score < best.score) best = { pane, score };
    }
    if (best) this.activate(best.pane);
  }

  /** Refits every console, at most once per frame. */
  refit(): void {
    if (this.refitQueued) return;
    this.refitQueued = true;
    requestAnimationFrame(() => {
      this.refitQueued = false;
      for (const pane of this.panes()) pane.resize();
    });
  }

  focusActive(): void {
    this.active?.focus();
  }

  /** The page is going away, so every console goes with it: each one closes
   *  its own connection, leaving no shell running for a window nobody can
   *  come back to. */
  shutdown(): void {
    for (const pane of this.panes()) pane.dispose();
    this.root = null;
    this.active = null;
  }

  /** A page load is always a clean slate: one console, on a fresh session. */
  start(): void {
    this.root = leaf(new TerminalPane(this, null, this.fontSize));
    this.draw();
    const first = this.panes()[0];
    if (first) this.activate(first);
    this.refit();
  }

  private panes(): TerminalPane[] {
    return this.root ? leaves(this.root) : [];
  }

  /* ---- rendering ---- */

  private draw(): void {
    stageEl.replaceChildren();
    if (this.root) stageEl.append(this.build(this.root));
    stageEl.dataset.count = String(this.panes().length);
    for (const pane of this.panes()) pane.render();
  }

  private build(node: LayoutNode): HTMLElement {
    if (node.kind === 'leaf') return sized(node.pane.pane, node.share);

    normalized(node.children);
    const el = document.createElement('div');
    el.className = 'split';
    el.dataset.dir = node.dir;
    node.children.forEach((child, i) => {
      if (i) el.append(this.buildSplitter(node, i));
      el.append(this.build(child));
    });
    return sized(el, node.share);
  }

  /** The handle between `branch.children[index - 1]` and `[index]`. */
  private buildSplitter(branch: Branch, index: number): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'splitter';
    el.dataset.dir = branch.dir;
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', branch.dir === 'row' ? 'vertical' : 'horizontal');
    el.setAttribute('aria-label', 'Resize consoles');
    el.title = 'Drag to resize · double-click to even out';
    el.addEventListener('pointerdown', (event) => this.startDrag(event, el, branch, index));
    el.addEventListener('dblclick', () => this.evenOut(branch));
    el.addEventListener('keydown', (event) => {
      const [back, forward] = branch.dir === 'row'
        ? ['ArrowLeft', 'ArrowRight']
        : ['ArrowUp', 'ArrowDown'];
      if (event.key === back) this.nudge(el, branch, index, -NUDGE);
      else if (event.key === forward) this.nudge(el, branch, index, NUDGE);
      else return;
      event.preventDefault();
    });
    return el;
  }

  private startDrag(event: PointerEvent, el: HTMLElement, branch: Branch, index: number): void {
    const pair = neighbours(el, branch, index);
    if (event.button !== 0 || !pair) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    document.body.style.cursor = branch.dir === 'row' ? 'col-resize' : 'row-resize';

    // Sizes are read once, so the consoles do not chase the pointer as they reflow.
    const base = measure(pair, branch.dir);
    const start = along(event, branch.dir);
    const move = (moved: PointerEvent) =>
      this.slide(pair, branch.dir, base, along(moved, branch.dir) - start);
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      this.refit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop, { once: true });
    el.addEventListener('pointercancel', stop, { once: true });
  }

  /** Keyboard equivalent of one drag step. */
  private nudge(el: HTMLElement, branch: Branch, index: number, delta: number): void {
    const pair = neighbours(el, branch, index);
    if (!pair) return;
    this.slide(pair, branch.dir, measure(pair, branch.dir), delta);
  }

  /** Hands `delta` pixels from one side of a splitter to the other. */
  private slide(pair: Pair, dir: Direction, base: Span, delta: number): void {
    const total = base.before + base.after;
    if (!total) return;
    const min = MIN[dir];
    const size = clamp(base.before + delta, min, Math.max(min, total - min));
    // Only these two trade room, so their combined share stays put.
    const share = pair.before.share + pair.after.share;
    pair.before.share = share * (size / total);
    pair.after.share = share - pair.before.share;
    pair.beforeEl.style.flex = `${pair.before.share} 1 0`;
    pair.afterEl.style.flex = `${pair.after.share} 1 0`;
    this.refit();
  }

  /** Gives one branch's children the same size again. */
  private evenOut(branch: Branch): void {
    for (const child of branch.children) child.share = 1;
    this.draw();
    this.focusActive();
    this.refit();
  }
}

/** The two nodes a splitter sits between, with the elements showing them. */
interface Pair {
  before: LayoutNode;
  after: LayoutNode;
  beforeEl: HTMLElement;
  afterEl: HTMLElement;
}

/** The sizes a splitter drag started from, in pixels. */
interface Span {
  before: number;
  after: number;
}

function neighbours(el: HTMLElement, branch: Branch, index: number): Pair | null {
  const before = branch.children[index - 1];
  const after = branch.children[index];
  const beforeEl = el.previousElementSibling;
  const afterEl = el.nextElementSibling;
  if (!before || !after) return null;
  if (!(beforeEl instanceof HTMLElement) || !(afterEl instanceof HTMLElement)) return null;
  return { before, after, beforeEl, afterEl };
}

function measure(pair: Pair, dir: Direction): Span {
  const of = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    return dir === 'row' ? box.width : box.height;
  };
  return { before: of(pair.beforeEl), after: of(pair.afterEl) };
}

function along(event: PointerEvent, dir: Direction): number {
  return dir === 'row' ? event.clientX : event.clientY;
}

function centre(pane: TerminalPane): { x: number; y: number } {
  const box = pane.pane.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function sized(el: HTMLElement, share: number): HTMLElement {
  el.style.flex = `${share} 1 0`;
  return el;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const app = new Console();

window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || !event.shiftKey) return;
  switch (event.key.toLowerCase()) {
    case 't': event.preventDefault(); app.split('row'); break;
    case 'd': event.preventDefault(); app.split('column'); break;
    case 'w': event.preventDefault(); app.closeActive(); break;
    case 'arrowright': event.preventDefault(); app.navigate(1, 0); break;
    case 'arrowleft': event.preventDefault(); app.navigate(-1, 0); break;
    case 'arrowdown': event.preventDefault(); app.navigate(0, 1); break;
    case 'arrowup': event.preventDefault(); app.navigate(0, -1); break;
  }
});

/** True when this build is mounted somewhere below the site root, which is
 *  the only case where "go to /" means anywhere other than here. An absolute
 *  base is not one of them: that only moves the assets to a CDN, and the app
 *  itself still serves from /. */
function mountedUnderSubPath(): boolean {
  const base = import.meta.env.BASE_URL;
  return base.startsWith('/') && base !== '/';
}

/** What this is, named the way the catalog entry names it. A console served
 *  under a base gets a way back out of it first. */
function renderHeader(): void {
  if (mountedUnderSubPath()) {
    const home = document.createElement('a');
    home.className = 'home';
    home.href = '/';
    home.textContent = 'Home';
    headerEl.append(home);
  }

  const name = document.createElement('strong');
  name.textContent = __TITLE__;
  headerEl.append(name);
}

/** Who owns this, under which licence, and where the source is. The link is
 *  whatever package.json's `homepage` says, so the URL is never written down
 *  twice; without one there is nothing to point at and the footer says the
 *  first two only. */
function renderFooter(): void {
  footerEl.append('Copyright © 2026 · MIT');
  if (!__HOMEPAGE__) return;

  const link = document.createElement('a');
  link.href = __HOMEPAGE__;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = 'GitHub';
  footerEl.append(' · ', link);
}

renderHeader();
renderFooter();

new ResizeObserver(() => app.refit()).observe(stageEl);
window.addEventListener('focus', () => app.focusActive());
// `persisted` means the page is only being parked in the back/forward cache,
// and the consoles it holds are still live.
window.addEventListener('pagehide', (event) => { if (!event.persisted) app.shutdown(); });

app.start();
