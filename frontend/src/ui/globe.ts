/**
 * Home-screen globe: MapLibre GL in globe projection with free OpenFreeMap
 * tiles (no API key). Shows listings near a chosen point as photo pins, and
 * flies down to a building when one is opened. Styling follows Openhere.
 */
import maplibregl, { type Map as MlMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface MapListing {
  id: string;
  lat: number;
  lng: number;
  title: string;
  photoUrl: string | null;
}

const dark = matchMedia('(prefers-color-scheme: dark)');
const styleUrl = () => `https://tiles.openfreemap.org/styles/${dark.matches ? 'dark' : 'positron'}`;
const isPhone = () => matchMedia('(max-width: 899px)').matches;

export class Globe {
  map: MlMap | null = null;
  private pins = new Map<string, Marker>();
  private drop: Marker | null = null;
  private spinning = true;
  private onPoint: ((lat: number, lng: number) => void) | null = null;

  constructor(private el: HTMLElement) {
    try {
      this.map = new maplibregl.Map({ container: el, style: styleUrl(), center: [-30, 38], zoom: 1.5, attributionControl: { compact: true } });
    } catch (e) {
      console.warn('Map could not start (WebGL unavailable?)', e);
      el.classList.add('map-failed');
      return;
    }
    const map = this.map;
    map.on('style.load', () => this.restyle());
    dark.addEventListener('change', () => map.setStyle(styleUrl()));
    const spin = () => {
      if (!this.spinning || map.isMoving() || this.el.hidden) return;
      const c = map.getCenter();
      map.easeTo({ center: [c.lng + 10, c.lat], duration: 4000, easing: (t) => t });
    };
    map.on('load', spin);
    map.on('moveend', spin);
    for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) map.on(ev, () => (this.spinning = false));
    map.on('click', (e) => this.onPoint?.(e.lngLat.lat, e.lngLat.lng));
  }

  /** Quiet neutral base map; 3D buildings fade in when close. */
  private restyle() {
    const map = this.map!;
    map.setProjection({ type: 'globe' });
    const c = dark.matches
      ? { bg: '#0e1013', water: '#141b2b', park: '#121a17', building: '#1b1f27', land: '#11141a', extrude: '#262b36' }
      : { bg: '#eef0f3', water: '#d6e0f5', park: '#e1ece4', building: '#e3e6ec', land: '#e9ebef', extrude: '#dde1e8' };
    for (const layer of map.getStyle().layers) {
      if (layer.id === 'background') map.setPaintProperty(layer.id, 'background-color', c.bg);
      else if (/water/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.water);
      else if (/park|landcover_wood|grass/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.park);
      else if (/building/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.building);
      else if (/landuse|residential|landcover/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.land);
    }
    if (!map.getLayer('buildings-3d') && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 15,
        paint: {
          'fill-extrusion-color': c.extrude,
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.85],
        },
      });
    }
  }

  onPick(fn: (lat: number, lng: number) => void) {
    this.onPoint = fn;
  }

  show(on: boolean) {
    this.el.hidden = !on;
    if (on) this.map?.resize();
  }

  /** Padding that keeps targets clear of the sidebar / bottom sheet. */
  private padding() {
    return isPhone() ? { top: 80, bottom: Math.round(innerHeight * 0.55), left: 30, right: 30 } : { top: 80, bottom: 60, left: 60, right: 60 };
  }

  dropAt(lat: number, lng: number) {
    if (!this.map) return;
    this.spinning = false;
    this.drop?.remove();
    const d = document.createElement('div');
    d.className = 'map-drop';
    this.drop = new maplibregl.Marker({ element: d }).setLngLat([lng, lat]).addTo(this.map);
    this.map.flyTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 13.5), pitch: 0, duration: 1600, padding: this.padding(), essential: true });
  }

  setListings(list: MapListing[], onClick: (id: string) => void) {
    if (!this.map) return;
    this.pins.forEach((m) => m.remove());
    this.pins.clear();
    if (!list.length) return;
    const bounds = new maplibregl.LngLatBounds();
    list.forEach((l, i) => {
      const pin = document.createElement('button');
      pin.className = 'map-pin';
      pin.title = l.title;
      pin.setAttribute('aria-label', l.title);
      if (l.photoUrl) pin.style.backgroundImage = `url("${l.photoUrl.replace(/"/g, '%22')}")`;
      const n = document.createElement('span');
      n.textContent = String(i + 1);
      pin.append(n);
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(l.id);
      });
      this.pins.set(l.id, new maplibregl.Marker({ element: pin }).setLngLat([l.lng, l.lat]).addTo(this.map!));
      bounds.extend([l.lng, l.lat]);
    });
    if (this.drop) bounds.extend(this.drop.getLngLat());
    this.map.fitBounds(bounds, { padding: this.padding(), maxZoom: 15.5, duration: 1300 });
  }

  highlight(id: string | null) {
    this.pins.forEach((m, k) => m.getElement().classList.toggle('active', k === id));
  }

  /** Tilted fly-in to a building, resolved when the camera settles. */
  async flyToBuilding(lat: number, lng: number) {
    if (!this.map) return;
    const map = this.map;
    map.flyTo({ center: [lng, lat], zoom: 17.4, pitch: 55, bearing: map.getBearing() - 20, duration: 1700, curve: 1.4, padding: this.padding(), essential: true });
    await new Promise<void>((r) => {
      map.once('moveend', () => r());
      setTimeout(r, 2300);
    });
  }

  clear() {
    this.pins.forEach((m) => m.remove());
    this.pins.clear();
    this.drop?.remove();
    this.drop = null;
  }
}
