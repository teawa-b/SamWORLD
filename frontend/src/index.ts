import { SessionMode, World, effect } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { app } from './state.js';
import { DollhouseSystem, mountHouse, unmountHouse } from './systems/dollhouse.js';
import { MenuSystem } from './systems/menu.js';
import { WalkthroughSystem } from './systems/walkthrough.js';
import { icon } from './ui/icons.js';
import { Globe } from './ui/globe.js';
import { Panel } from './ui/panel.js';
import { Sheet } from './ui/sheet.js';
import './ui/styles.css';

const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);
if (import.meta.env.DEV) (window as unknown as { __walkin: unknown }).__walkin = { world, app };
world.registerSystem(DollhouseSystem).registerSystem(WalkthroughSystem).registerSystem(MenuSystem);

// Rebuild the 3D house whenever a new scene manifest arrives.
let mountedVersion = '';
effect(() => {
  const scene = app.scene.value;
  const key = scene ? `${scene.propertyId}:${scene.sceneVersion}:${scene.complete}` : '';
  if (key === mountedVersion) return;
  mountedVersion = key;
  if (scene) mountHouse(world, scene);
  else unmountHouse(world);
});

document.querySelector('#topbar .logo')!.innerHTML = icon('roof', 14);

// Offer VR only when the browser actually supports an immersive session.
const xrButton = document.getElementById('enter-xr') as HTMLButtonElement;
xrButton.innerHTML = `${icon('headset', 18)}VR`;
navigator.xr
  ?.isSessionSupported(SessionMode.ImmersiveVR)
  .then((ok) => (xrButton.hidden = !ok))
  .catch(() => undefined);
xrButton.addEventListener('click', () => world.launchXR());

// On phones the sheet covers the bottom of the screen: shift the projection so
// the model is centred in the part of the canvas that is still visible.
const panelEl = document.getElementById('panel')!;
const sheet = new Sheet(panelEl);
const frame = () => {
  const cam = world.camera;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const covered = matchMedia('(max-width: 899px)').matches ? Math.min(panelEl.getBoundingClientRect().height, h * 0.5) : 0;
  if (covered > 0 && !app.inXR.value) cam.setViewOffset(w, h, 0, covered / 2, w, h);
  else cam.clearViewOffset();
};
sheet.onResize(() => requestAnimationFrame(frame));
panelEl.addEventListener('transitionend', frame);
window.addEventListener('resize', () => requestAnimationFrame(frame));
app.inXR.subscribe(frame);

const panel = new Panel(world, panelEl, sheet);
panel.attachGlobe(new Globe(document.getElementById('map')!));
await panel.start();
panel.initialSearch();
frame();
