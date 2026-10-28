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
}

type Name = keyof Collections;
const names: Name[] = ['properties', 'media', 'runs', 'scenes', 'interpretations', 'roomMappings', 'sceneCorrections', 'usage'];

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
