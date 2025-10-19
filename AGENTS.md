# Repository Guidelines

## Project Structure & Module Organization
- Monorepo with Python backend in `backend/app`; `main.py` bootstraps FastAPI routers from `routes/`, cloud adapters in `services/`, and streaming helpers in `chunker/` and `translator/`.
- Shared backend utilities live in `backend/app/utils/` and `backend/app/env.py`; keep environment defaults centralized there instead of hard-coding values.
- Next.js client resides in `frontend/`; UI components in `components/`, data helpers in `lib/` and `utils/`, static assets under `public/`, and Tailwind styles in `styles/`.
- Repo-level scripts (`update_env.py`, `frontend/utils/*.js`) manage network-aware configuration; avoid duplicating their responsibilities elsewhere.

## Build, Test, and Development Commands
- Backend: `python -m venv venv && source venv/bin/activate && pip install -r requirements.txt` to provision; `./start-backend.sh` (or `uvicorn app.main:app --reload`) for local API.
- Frontend: `npm install` then `npm run dev` for the Next.js dev server; `npm run update-env` refreshes `.env.local` with your LAN IP.
- End-to-end: `npm run dev-all` launches backend, frontend, health check, and QR helper in one terminal—ideal for demos on shared networks.
- Health: run `npm run check` after backend changes to confirm HTTP endpoints and the WebSocket handshake succeed.

## Coding Style & Naming Conventions
- Python modules follow PEP 8: 4-space indents, snake_case functions, PascalCase classes, and type hints on public surfaces. Document non-obvious streaming logic with concise docstrings.
- TypeScript files obey the flat ESLint config; resolve all `warn`-level findings before review. Components/hooks use PascalCase filenames; shared utilities expose camelCase exports.
- CSS is Tailwind-first; prefer utility classes and keep reusable tokens in `styles/globals.css`.

## Testing Guidelines
- Automated coverage is nascent; add backend tests with `pytest` under `backend/tests/`, mocking external APIs (OpenAI, Google Cloud) via fixtures. Target `routes/translate.py` and `services/gcp_translation.py` first.
- Frontend changes should include component or integration tests (e.g., Vitest or Playwright) co-located in `__tests__/`; at minimum validate manual flows through `frontend/pages/quick-test.tsx`.
- Always run `npm run check` post-update and verify real-time translation through `frontend/pages/test-broadcast.tsx` before merge.

## Commit & Pull Request Guidelines
- Match the existing concise, present-tense commit style (`add hybrid fallback`, `fix ws reconnect`), and keep one logical change per commit.
- Pull requests need a short problem/solution summary, testing evidence (commands + outcomes), linked issues, and UI screenshots or logs when behavior changes. Call out any credential assumptions (e.g., `google-translation.json`).

## Security & Configuration Tips
- Secrets (API keys, PEM files) stay in `.env`, `cert.pem`, and `google-translation.json`; never commit replacements—coordinate via secure sharing.
- Update `.env.local` via `python update_env.py` or `npm run update-env` whenever your network changes to avoid WebSocket failures.
- Ensure personal virtual environments remain untracked; remove `backend/venv/` from future commits and rely on setup steps above.
