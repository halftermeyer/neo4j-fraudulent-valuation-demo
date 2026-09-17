# Mismarking demo — replayable end-to-end pipeline (see DATA_PLAN.md)

.PHONY: env download data load test app all clean-data

env:              ## derive root .env and app/.env from inputs/.env
	python3 scripts/make_env.py

download:         ## cache OSBAP / FITRS / FRED under data/cache/ (one-time, resumable)
	python3 scripts/download_data.py

data: env download ## generate the three layers (JSON + load_data.cypher + gap query)
	uv run python generate_data.py

load:             ## load data/load_data.cypher into the mismarking database (CLI path; the app has its own Ingest flow)
	set -a && . ./.env && set +a && \
	cat data/load_data.cypher | cypher-shell -a "$$NEO4J_URI" -u "$$NEO4J_USER" -p "$$NEO4J_PASSWORD" -d "$$NEO4J_DATABASE" --format plain

test:             ## run the acceptance tests against the loaded database
	uv run pytest tests/ -v

app:              ## run the React app (Vite dev server)
	cd app && npm install && npm run dev

all: data load test

clean-data:       ## drop generated artifacts (caches are kept)
	rm -rf data/layers data/load_data.cypher data/holdout_links.json app/public/data
