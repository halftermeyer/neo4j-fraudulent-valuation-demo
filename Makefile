# Mismarking demo — replayable end-to-end pipeline (see DATA_PLAN.md)

.PHONY: env download data load test app all clean-data explain video

env:              ## derive root .env and app/.env from inputs/.env
	python3 scripts/make_env.py

download:         ## cache OSBAP / FITRS / FRED under data/cache/ (one-time, resumable)
	python3 scripts/download_data.py

data: env download ## generate the three layers (JSON + load_data.cypher + gap query)
	uv run python generate_data.py

load:             ## load data/load_data.cypher into the mismarking database (CLI path; the app has its own Ingest flow)
	set -a && . ./.env && set +a && \
	cat data/load_data.cypher | cypher-shell -a "$$NEO4J_URI" -u "$$NEO4J_USER" -p "$$NEO4J_PASSWORD" -d "$$NEO4J_DATABASE" --format plain

explain:          ## pre-generate AI-companion explanations for the scripted demo path
	## re-run after editing Policy defaults or after `make data` (the cache key
	## includes the active ControlObligation parameters; `make data` also wipes
	## app/public/data where the served copy lives)
	set -a && . ./.env && set +a && uv run python scripts/pregen_explanations.py

video:            ## record + narrate + assemble dist/demo.mp4 from the demo-script storyboard
	## prerequisites: app dev server running, DB reachable, ffmpeg, GEMINI_API_KEY
	## silent pacing cut: make video VIDEO_FLAGS=--no-audio
	uv run python scripts/record_demo.py $(VIDEO_FLAGS)
	uv run python scripts/assemble_video.py

test:             ## run the acceptance tests against the loaded database + the TS FastPath mirror
	uv run pytest tests/ -v
	cd app && npx vitest run

app:              ## run the React app (Vite dev server)
	cd app && npm install && npm run dev

all: data load test

clean-data:       ## drop generated artifacts (caches are kept)
	rm -rf data/layers data/load_data.cypher data/holdout_links.json app/public/data
