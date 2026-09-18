# CLAUDE.md — operating notes for this repo

Mismarking (fraudulent-valuation) detection demo: Neo4j + GDS graph, React app,
AI assistant/companion, reproducible data pipeline and narrated demo video.
Read `README.md` for architecture, `DATA_PLAN.md` for the validated data design,
`DECISIONS.md` for every resolved choice (numbered; append there, don't re-litigate),
`demo-script.md` for the presenter script + the machine-readable video storyboard.

## Environment (this machine)
- Neo4j 2026.05 Enterprise, native install, `bolt://127.0.0.1:7687`, database
  **`mismarking`**, GDS + APOC installed. Credentials in `inputs/.env` (single
  source of truth; `make env` derives root `.env` and `app/.env`). The password
  contains `!` — single-quote it in shell commands.
- Vite dev server: 5173/5174 are usually taken by OTHER demos on this machine —
  this app lands on **http://localhost:5175**. Never assume 5173; probe by page
  title ("Mismarking").
- Python via `uv` (pyproject at root). Node deps live in `app/` only — never run
  npm at repo root.

## Invariants (do not break)
1. `data/gap_query.cypher` is THE gap query — imported verbatim by
   `app/src/lib/queries.ts` (fetch at runtime), `mcp_server.py` and `tests/`.
   GovernanceGaps are always computed by it, never hand-placed.
2. Acceptance contract: POS-TP gap set == {R1,R2,R3,R4,R5,R6,R8,R9}, POS-FP ==
   {R2,R4,R6}, both read from `inputs/*.csv` at test time. `make test` must stay
   green after any change (12 tests incl. a live Gemini test needing
   GEMINI_API_KEY exported).
3. `inputs/*.csv` are customer DATA — semantics are frozen (one user-approved
   edit exists: seq-6 rules_broken = R3;R4;R8).
4. Read-across matches `:RiskAttribute` nodes and GovernanceGap classes, never
   instrument fields. Every event node: `:Event` label, `at` datetime,
   per-position `[:NEXT {timeDelta}]` chain. Case events keep `sourceAt`
   (authentic date, TP clock +10y) and `sourceRef` (citation).
5. Every query the app runs goes through `runQuery` in `app/src/lib/neo4j.ts`
   (audit drawer). The Assistant/companion never do free-form text-to-Cypher —
   typed tools only (`assistantTools.ts`, mirrored by `mcp_server.py`).
6. Companion cache keys = sha256(scene|selection|canonical params|lang), computed
   byte-identically in `companion.ts` and `scripts/pregen_explanations.py`
   (system prompts mirrored too — keep in sync).
7. The video storyboard = fenced ```scene blocks in demo-script.md; scene ids are
   API for `scripts/record_demo.py`. Recorder rules: data-testid for our
   elements, role selectors for NDL; per-scene framing via `frame_on`; long
   nondeterministic waits wrapped in `fast_begin/fast_end`.

## Commands
- `make data` → downloads (cached in `data/cache/`, ~1.9 GB) + regenerates layers
  (wipes `app/public/data/` → re-run `make explain` after).
- `make load` (CLI path) / in-app Ingest (UI path) — equivalent, both tested.
- `make test`, `make explain` (companion pregen, needs GEMINI_API_KEY),
  `make video [VIDEO_FLAGS=--no-audio]` (needs dev server up + ffmpeg).
- App checks: `cd app && npx tsc -b && npx oxlint src`. E2E driver: `app/e2e.mjs`.

## Gotchas
- neo4j-driver JS does NOT convert JS Date → use `DateTime.fromStandardDate`
  (see `neoDateTime` in queries.ts); Python driver needs tz-aware datetimes.
- NVL: `d3Force` layout + seeded positions for new nodes (GraphView.tsx) — the
  default layout does not re-simulate on element updates.
- OSBAP stage-1 parquet has NO rating/coupon columns (despite the data
  dictionary); brew ffmpeg has NO libass (subtitles = PNG overlays).
- generate_data.py is seeded (SEED=42, TP_CLOCK_OFFSET_YEARS=10) — regeneration
  is deterministic and reproduces the acceptance sets.
- git: repo = github.com/halftermeyer/neo4j-fraudulent-valuation-demo (public).
  Don't commit `dist/`, `data/cache|layers`, any `.env`, `app/public/data/`.
