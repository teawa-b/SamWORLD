/**
 * Bottom sheet for phones: three snap points (peek / half / full), drag the
 * grip to resize, tap it to cycle. On desktop the panel is a sidebar and
 * snapping is a no-op.
 */
export type Snap = 'peek' | 'half' | 'full';

const isPhone = () => window.matchMedia('(max-width: 899px)').matches;

export class Sheet {
  private snap: Snap = 'full';
  private onChange: (() => void) | null = null;

  constructor(private el: HTMLElement) {
    const grip = el.querySelector('.sheet-grip') as HTMLElement;
    let startY = 0;
    let startH = 0;
    let moved = false;
    grip.addEventListener('pointerdown', (e) => {
      if (!isPhone()) return;
      startY = e.clientY;
      startH = el.getBoundingClientRect().height;
      moved = false;
      grip.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!el.classList.contains('dragging')) return;
      const h = Math.min(this.px('full'), Math.max(this.px('peek') * 0.8, startH + (startY - e.clientY)));
      if (Math.abs(startY - e.clientY) > 4) moved = true;
      this.apply(`${h}px`);
    });
    const end = () => {
      if (!el.classList.contains('dragging')) return;
      el.classList.remove('dragging');
      const h = el.getBoundingClientRect().height;
      if (!moved) {
        this.set(this.snap === 'peek' ? 'half' : this.snap === 'half' ? 'full' : 'peek');
        return;
      }
      const nearest = (['peek', 'half', 'full'] as Snap[]).sort((a, b) => Math.abs(this.px(a) - h) - Math.abs(this.px(b) - h))[0];
      this.set(nearest);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.set(this.snap));
  }

  onResize(fn: () => void) {
    this.onChange = fn;
  }

  private px(s: Snap): number {
    const vh = window.innerHeight;
    if (s === 'peek') return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek')) || 212;
    if (s === 'half') return Math.round(vh * 0.5);
    return vh - 64;
  }

  private apply(h: string) {
    document.documentElement.style.setProperty('--sheet-h', h);
    this.onChange?.();
  }

  set(s: Snap) {
    this.snap = s;
    if (!isPhone()) {
      document.documentElement.style.setProperty('--sheet-h', '0px');
      return;
    }
    this.apply(`${this.px(s)}px`);
  }

  get current() {
    return this.snap;
  }
}
