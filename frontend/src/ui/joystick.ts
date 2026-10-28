/** On-screen joystick for walking on touch screens; feeds the walkthrough. */
import { virtualStick } from '../systems/walkthrough.js';

export function bindJoystick(el: HTMLElement) {
  const knob = el.querySelector('.knob') as HTMLElement;
  const R = 46;
  let id: number | null = null;
  let cx = 0;
  let cy = 0;
  const move = (e: PointerEvent) => {
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx = (dx / d) * R;
      dy = (dy / d) * R;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    virtualStick.x = dx / R;
    virtualStick.y = dy / R;
  };
  const reset = () => {
    id = null;
    knob.style.transform = '';
    virtualStick.x = 0;
    virtualStick.y = 0;
  };
  el.addEventListener('pointerdown', (e) => {
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    id = e.pointerId;
    el.setPointerCapture(e.pointerId);
    move(e);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
  el.addEventListener('pointerup', reset);
  el.addEventListener('pointercancel', reset);
}
