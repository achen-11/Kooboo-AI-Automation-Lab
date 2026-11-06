# Frontend

The active application is Vue 3 + Vite with an independent Node.js server. The SPA uses hash routing and root entry `/`; source lives in `frontend/src/` and shared application types live in `shared/`.

`npm run dev` starts the Node API and background worker at `http://127.0.0.1:4180`. For frontend hot reload, run `npm run dev:web` separately; Vite listens on `http://127.0.0.1:4181` and proxies `/api` to the Node server.

`npm run build` writes frontend assets into `dist/` and compiles readable Node modules into `dist-server/`. `npm start` serves the SPA and API together. Former Kooboo runtime resources have been removed; the old implementation is available in Git history.

Keep the existing page layout, task stages, execution history, screenshot comparison, and site-preview iframe. The entry screen establishes a local session using `POST /api/login` without Kooboo username or password; logout clears that session. This is a local workspace entry, not production user authentication.

Settings include a single configurable image- and tool-capable Chat Completions model, Kooboo environments, review threshold, queue pause, a stage budget for each viewport capture and final scoring, and bounded capture attempts. Keep secret fields empty after saving and retain the existing secret unless explicitly replaced or cleared. Model tests submit actual pixels and validate function calls and tool result consumption.

The active backend is `server/`, contracts are `shared/`, evaluation instructions are `sop/`, and focused tests are `tests-node/`. The former `src/api/`, `src/code/`, `src/job/`, native binding types, and obsolete site publishing scripts are no longer part of the current tree. `kb push` is not part of the current development or deployment flow.
