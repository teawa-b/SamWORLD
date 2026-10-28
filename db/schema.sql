-- Postgres (Supabase) schema mirroring shared/src/schemas.ts.
-- NOT yet used: the prototype persists to JSON files (api/src/store.ts).
-- Large structured blobs stay JSONB; they are validated by the Zod schemas.

create table properties (
  id text primary key,
  source_provider text not null,
  source_listing_id text not null,
  listing_url text,
  address text not null,
  location jsonb,
  status text not null,
  price jsonb,
  bedrooms int,
  area_sq_m numeric,
  area_evidence text,
  source_info jsonb not null,
  missing_data jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_provider, source_listing_id)
);

create table property_media (
  id text primary key,
  property_id text not null references properties(id) on delete cascade,
  type text not null check (type in ('photo','video','floorplan','historical')),
  storage_key text not null,
  mime_type text not null,
  source_url text,
  page_or_frame int,
  capture_date timestamptz,
  level_guess text,
  room_guess text,
  usage_rights_status text not null check (usage_rights_status in ('owned-by-project','licensed','permission-granted','unverified')),
  metadata jsonb not null default '{}'
);

-- Cached Muse plan readings (source of truth for rebuilds without AI calls)
create table floorplan_interpretations (
  property_id text primary key references properties(id) on delete cascade,
  interpretation jsonb not null,
  created_at timestamptz not null default now()
);

create table reconstruction_runs (
  id text primary key,
  property_id text not null references properties(id) on delete cascade,
  state text not null,
  step text not null,
  progress real not null default 0,
  attempts int not null default 0,
  options jsonb not null,
  heartbeat_at timestamptz,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  model_versions jsonb not null default '{}',
  prompt_versions jsonb not null default '{}',
  ai_calls int not null default 0,
  total_cost_estimate text,
  output_scene_version int,
  logs jsonb not null default '[]'
);
create index on reconstruction_runs (state);

-- Versioned scene manifests (levels, rooms, openings, walls, objects inside)
create table scene_manifests (
  property_id text not null references properties(id) on delete cascade,
  scene_version int not null,
  complete boolean not null,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  primary key (property_id, scene_version)
);

create table room_mapping_corrections (
  property_id text primary key references properties(id) on delete cascade,
  patch jsonb not null,
  updated_at timestamptz not null default now()
);

create table scene_corrections (
  property_id text primary key references properties(id) on delete cascade,
  patch jsonb not null,
  updated_at timestamptz not null default now()
);
