# Project instructions

- This directory is the active Site Evaluator project: Vue frontend plus an independent Node.js API and background worker. The older `../ai_site_evaluator` is historical reference; do not modify or start it unless the user explicitly asks.
- Read `README.md` and `.kooboo-ai/specs/frontend.md` before changing runtime, deployment, or resource layout.
- Maintain active server code directly in `server/`, shared contracts in `shared/`, focused tests in `tests-node/`, and evaluation SOP documents in `sop/`. The OpenAI-compatible SDK must use configurable endpoint, model name, and API key; do not bind execution to Codex or a specific model.
- The former Kooboo runtime resources under `src/api/`, `src/code/`, and `src/job/`, native binding types, and obsolete site publishing scripts have been removed. Consult Git history for the old implementation. Do not restore Kooboo runtime resources or use `kb push` as the deployment path.
- Keep runtime data, API keys, environment tokens, `.env`, `.data/`, vault keys, and generated `kooboo.d.ts` out of Git and logs. Preserve the existing local `.data/` and its master key when copying source from a temporary workspace.
- Local configuration is encrypted inside `.data/`; backups must include both data and its master key. Do not overwrite existing runtime configuration or regenerate its key during build.
- Local administration uses an explicit entry action and a local session. The default service binds to `127.0.0.1:4180`; production network deployment and user authentication require a separate design.
- Preserve stage checkpoints, source-run evidence references, versioned rules/SOP snapshots, and Admin integration contracts. Model image capability must be tested with actual image input, not a text-only connectivity check.
- Validate changes with focused tests, type checks, and build as appropriate. Do not claim real model, browser, remote, or visual acceptance from mocked tests. Browser control requires explicit user permission.
