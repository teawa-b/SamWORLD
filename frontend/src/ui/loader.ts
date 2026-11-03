/**
 * The loading screen over the 3D view: the room's own frames, drawn as big pixels that sharpen as the work
 * progresses, with the SamWORLD cube breathing in the middle. Frames cross-fade every couple of seconds.
 */
const LOGO = `${import.meta.env.BASE_URL}brand/`;

export interface LoaderState {
  title: string;
  sub: string;
  /** 0–1 when known (pixels sharpen and a bar fills); null while waiting on the server. */
  progress: number | null;
  /** Frame images to show behind (URLs or object URLs). */
  frames: string[];
}

export class StageLoader {
  private el: HTMLElement;
  private canvases: HTMLCanvasElement[];
  private front = 0;
  private frames: string[] = [];
  private index = 0;
  private progress: number | null = null;
  private timer: number | null = null;
  private cache = new Map<string, HTMLImageElement>();
  private drawn = '';

  constructor(stage: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'stage-loader';
    this.el.hidden = true;
    this.el.innerHTML = `<canvas></canvas><canvas></canvas><div class="sl-shade"></div>
      <div class="sl-center" role="status" aria-live="polite">
        <div class="mark-loader lg"><img src="${LOGO}mark.png" alt="" /></div>
        <b class="sl-title"></b><span class="sl-sub"></span>
        <div class="sl-bar"><i></i></div>
      </div>`;
    stage.appendChild(this.el);
    this.canvases = [...this.el.querySelectorAll('canvas')];
    window.addEventListener('resize', () => this.redraw());
  }

  show(s: LoaderState | null) {
    if (!s) {
      if (!this.el.hidden) {
        this.el.classList.add('leaving');
        window.setTimeout(() => {
          if (this.el.classList.contains('leaving')) this.el.hidden = true;
        }, 450);
      }
      this.stop();
      return;
    }
    this.el.classList.remove('leaving');
    this.el.hidden = false;
    (this.el.querySelector('.sl-title') as HTMLElement).textContent = s.title;
    (this.el.querySelector('.sl-sub') as HTMLElement).textContent = s.sub;
    const bar = this.el.querySelector('.sl-bar') as HTMLElement;
    bar.classList.toggle('waiting', s.progress == null);
    (bar.firstElementChild as HTMLElement).style.width = s.progress == null ? '' : `${Math.round(s.progress * 100)}%`;
    const framesChanged = s.frames.join('|') !== this.frames.join('|');
    const sharper = s.progress != null && this.progress != null && Math.abs(s.progress - this.progress) > 0.04;
    this.frames = s.frames;
    this.progress = s.progress;
    this.el.classList.toggle('no-frames', !s.frames.length);
    if (framesChanged || sharper || !this.drawn) this.redraw();
    if (!this.timer && s.frames.length > 1) this.timer = window.setInterval(() => this.next(), 1800);
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private next() {
    if (this.frames.length < 2) return;
    this.index = (this.index + 1) % this.frames.length;
    this.front = 1 - this.front;
    this.redraw();
  }

  /** Draw the current frame tiny, then let CSS scale it up with `image-rendering: pixelated`. */
  private redraw() {
    const url = this.frames.length ? this.frames[this.index % this.frames.length] : '';
    if (!url) return;
    const img = this.image(url);
    const paint = () => {
      const c = this.canvases[this.front];
      const w = this.el.clientWidth || window.innerWidth;
      const h = this.el.clientHeight || window.innerHeight;
      // About 22 big pixels across while waiting; up to about 90 as the work completes.
      const cols = Math.round(22 + 68 * Math.min(1, Math.max(0, this.progress ?? 0)));
      c.width = cols;
      c.height = Math.max(1, Math.round((cols * h) / w));
      const g = c.getContext('2d')!;
      g.imageSmoothingEnabled = true;
      const scale = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      g.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      this.canvases[this.front].classList.add('on');
      this.canvases[1 - this.front].classList.remove('on');
      this.drawn = url;
    };
    if (img.complete && img.naturalWidth) paint();
    else img.onload = paint;
  }

  private image(url: string) {
    let img = this.cache.get(url);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = url;
      this.cache.set(url, img);
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
    }
    return img;
  }
}

/** The small breathing cube, for inline “working” states (buttons, pills, rows). */
export const markSpinner = (cls = '') => `<span class="mark-loader ${cls}"><img src="${LOGO}mark.png" alt="" /></span>`;
