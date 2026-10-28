import { SessionMode, World, effect } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { app } from './state.js';
import { DollhouseSystem, mountHouse, unmountHouse } from './systems/dollhouse.js';
import { MenuSystem } from './systems/menu.js';
import { WalkthroughSystem } from './systems/walkthrough.js';
import { Panel } from './ui/panel.js';
import './ui/styles.css';

const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);
if (import.meta.env.DEV) (window as unknown as { __pxr: unknown }).__pxr = { world, app };
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

// Offer XR only when the browser actually supports an immersive VR session.
const xrButton = document.getElementById('enter-xr') as HTMLButtonElement;
navigator.xr
  ?.isSessionSupported(SessionMode.ImmersiveVR)
  .then((ok) => {
    xrButton.hidden = !ok;
  })
  .catch(() => undefined);
xrButton.addEventListener('click', () => world.launchXR());

const panel = new Panel(world, document.getElementById('panel')!);
panel.bindSearch();
panel.bindRoomPicker();
await panel.start();
