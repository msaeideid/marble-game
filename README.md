# VANGUARD (working title)

A light-hearted 3D third-person co-op superhero game for the browser (1–4 players).
TypeScript + Babylon.js client, Python/FastAPI server. See [PLAN.md](PLAN.md) for the full plan.

## Run it

```bash
npm install
npm run dev          # client at http://localhost:5173
npm test             # client unit tests
cd server && uv sync && uv run pytest && uv run uvicorn app.main:app --reload
```

## Layout
`client/` browser game · `server/` FastAPI · `shared/` data, schemas, levels · `docs/` short system docs.

All characters are original; see PLAN.md §1 for the IP-safety rules.
