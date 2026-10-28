/** Room name sprites (canvas textures) shown in dollhouse mode. */
import { CanvasTexture, Sprite, SpriteMaterial, SRGBColorSpace } from '@iwsdk/core';

const BADGE: Record<'photo' | 'plan' | 'estimated', { text: string; color: string }> = {
  photo: { text: 'photo evidence', color: '#2f8f5b' },
  plan: { text: 'plan only', color: '#a07a1f' },
  estimated: { text: 'estimated', color: '#b5473f' },
};

export function makeLabel(text: string, badge: keyof typeof BADGE): Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,22,26,0.82)';
  g.beginPath();
  g.roundRect(8, 8, 496, 144, 28);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = '600 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(text, 256, 78, 470);
  g.fillStyle = BADGE[badge].color;
  g.font = '500 34px system-ui, sans-serif';
  g.fillText(BADGE[badge].text, 256, 126);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true }));
  s.scale.set(1.3, 0.41, 1);
  s.userData = { kind: 'label' };
  return s;
}
