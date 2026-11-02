/**
 * Minimal persistent store: one JSON file per collection, atomic writes
 * (write temp + rename), serialised through a single promise chain. This is
 * the "simple persistent job table" the spec allows for the first prototype;
 * db/schema.sql has the equivalent Supabase Postgres tables for later.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  FloorplanInterpretation,
  Property,
  PropertyMedia,
  ReconstructionRun,
  RoomMappingPatch,
  RoomShell,
  SceneCorrectionPatch,
  SceneManifest,
} from './shared/index.js';
import { config } from './config.js';

export interface Collections {
  properties: Record<string, Property>;
  media: Record<string, PropertyMedia>;
  runs: Record<string, ReconstructionRun>;
  scenes: Record<string, SceneManifest>; // latest scene per property
  interpretations: Record<string, FloorplanInterpretation>; // cached per property
  roomMappings: Record<string, RoomMappingPatch>;
  sceneCorrections: Record<string, SceneCorrectionPatch>;
  usage: Record<string, { day: string; redesigns: number }>;
  /** Per-object SAM 3D requests started from the viewer. */
  objectJobs: Record<string, ObjectJob>;
  /** Roomshift: room captures and their 3D reconstruction. */
  scans: Record<string, Scan>;
  /** Roomshift: one "type a world" run on a scan. */
  restyles: Record<string, Restyle>;
}

export type SurfaceId = 'walls' | 'floor' | 'ceiling';

export interface RestylePlan {
  /** Short name for the world, e.g. "Haunted Victorian library". */
  title: string;
  brief: string;
  surfaces: Record<SurfaceId, { prompt: string; colorHex: string; tileMetres: number }>;
  light: { colorHex: string; intensity: number };
  fogHex: string;
}

export interface RestyleSurface {
  id: SurfaceId;
  state: 'pending' | 'running' | 'done' | 'failed';
  /** File under /api/textures/ once painted. */
  texture: string | null;
  model: string | null;
  error: string | null;
  seconds: number | null;
}

export interface Restyle {
  id: string;
  scanId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  state: 'planning' | 'painting' | 'done' | 'failed';
  message: string;
  plan: RestylePlan | null;
  surfaces: RestyleSurface[];
  /** True when MODEL_API_KEY is unset: the plan and textures are local placeholders, not Meta output. */
  offline: boolean;
  models: string[];
  usage: string;
}

export interface ScanCamera {
  /** 4×4 world-from-camera, row-major, metres, y-up (three.js convention: camera looks down -z). */
  pose: number[];
  /** fx, fy, cx, cy in pixels of the frame as uploaded. */
  intrinsics: [number, number, number, number];
  width: number;
  height: number;
}

export interface Scan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  frames: { file: string; bytes: number; width: number; height: number }[];
  state: 'collecting' | 'reconstructing' | 'ready' | 'failed';
  message: string;
  /** Point cloud (binary PLY, xyz float + rgb uchar, metres, y-up) once reconstructed. */
  cloud: { file: string; points: number } | null;
  cameras: ScanCamera[];
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  model: string | null;
  timings: Record<string, number>;
  /** Floor, ceiling and walls fitted to the cloud (room frame: floor y = 0, centred, axis-aligned walls). */
  shell?: RoomShell | null;
}

export interface ObjectJob {
  id: string;
  propertyId: string;
  objectId: string;
  detectionId: string;
  state: 'running' | 'done' | 'failed';
  message: string;
  startedAt: string;
  finishedAt: string | null;
}

type Name = keyof Collections;
const names: Name[] = ['properties', 'media', 'runs', 'scenes', 'interpretations', 'roomMappings', 'sceneCorrections', 'usage', 'objectJobs', 'scans', 'restyles'];

class Store {
  private cache = new Map<Name, Record<string, unknown>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private dir: string) {}

  private file(name: Name) {
    return join(this.dir, `${name}.json`);
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const n of names) {
      const f = this.file(n);
      this.cache.set(n, existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : {});
    }
  }

  /** Re-read from disk (used by a separate worker process). */
  async refresh(name: Name): Promise<void> {
    const f = this.file(name);
    if (existsSync(f)) this.cache.set(name, JSON.parse(await readFile(f, 'utf8')));
  }

  all<N extends Name>(name: N): Collections[N] {
    return this.cache.get(name) as Collections[N];
  }

  get<N extends Name>(name: N, id: string): Collections[N][string] | undefined {
    return (this.cache.get(name) as Record<string, unknown>)[id] as Collections[N][string] | undefined;
  }

  async put<N extends Name>(name: N, id: string, value: Collections[N][string]): Promise<void> {
    (this.cache.get(name) as Record<string, unknown>)[id] = value;
    await this.flush(name);
  }

  async del<N extends Name>(name: N, id: string): Promise<void> {
    delete (this.cache.get(name) as Record<string, unknown>)[id];
    await this.flush(name);
  }

  private flush(name: Name): Promise<void> {
    const snapshot = JSON.stringify(this.cache.get(name), null, 1);
    const next = this.chain.then(async () => {
      const f = this.file(name);
      const tmp = `${f}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, f);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export const store = new Store(config.dataDir);
