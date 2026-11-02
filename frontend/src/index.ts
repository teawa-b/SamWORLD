import { SessionMode, World, effect } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { app } from './state.js';
import { DollhouseSystem, mountHouse, unmountHouse } from './systems/dollhouse.js';
import { MenuSystem } from './systems/menu.js';
import { resetOrbit, WalkthroughSystem } from './systems/walkthrough.js';
import { installObjectPicking } from './systems/objects.js';
import { icon } from './ui/icons.js';
import { RoomshiftPanel } from './ui/roomshift.js';
import { RoomshiftSystem } from './scene/roomshift-scene.js';
import { Sheet } from './ui/sheet.js';
import './ui/styles.css';

const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);
if (import.meta.env.DEV) (window as unknown as { __walkin: unknown }).__walkin = { world, app };
world.registerSystem(DollhouseSystem).registerSystem(WalkthroughSystem).registerSystem(MenuSystem).registerSystem(RoomshiftSystem);
installObjectPicking(world);

// Rebuild the 3D house whenever a new scene manifest arrives.
let mountedVersion = '';
let mountedProperty = '';
effect(() => {
  const scene = app.scene.value;
  const key = scene ? `${scene.propertyId}:${scene.sceneVersion}:${scene.complete}` : '';
  if (key === mountedVersion) return;
  mountedVersion = key;
  const fresh = !!scene && mountedProperty !== scene.propertyId;
  if (scene) {
    mountHouse(world, scene);
    // A newly opened property: show the rooms (roof off) and frame the whole house.
    if (fresh && !app.inXR.value) {
      app.roofHidden.value = true;
      if (app.mode.value !== 'walk') resetOrbit(world);
    }
    mountedProperty = scene.propertyId;
  } else {
    unmountHouse(world);
    mountedProperty = '';
  }
});

document.querySelector('#topbar .logo')!.innerHTML = icon('roof', 14);

// Roomshift re-enables the VR button (DETAIL.md): the scanned room is in metres with its centre at the
// origin, so entering VR stands you in the middle of your room at 1:1. VITE_ENABLE_XR=false hides it.
const xrButton = document.getElementById('enter-xr') as HTMLButtonElement;
xrButton.innerHTML = `${icon('headset', 18)}VR`;
if (import.meta.env.VITE_ENABLE_XR !== 'false')
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

// Roomshift (DETAIL.md): the old listing panel and globe are replaced on this branch.
document.getElementById('map')?.remove();
sheet.set('half');
const panel = new RoomshiftPanel(world, panelEl);
await panel.start();
frame();
