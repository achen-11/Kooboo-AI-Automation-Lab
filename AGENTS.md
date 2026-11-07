# Project instructions

- This directory is the active Kooboo AI Automation Lab: Vue frontend plus an independent Node.js API and background workers. Maintain the unified automation platform here. The sibling `../site_evaluator_impl` is the original independent evaluator; do not modify it for Automation Lab features. The older `../ai_site_evaluator` is historical reference.
- Read `README.md` and `.kooboo-ai/specs/frontend.md` before changing runtime, deployment, or resource layout.
- Maintain active server code directly in `server/`, shared contracts in `shared/`, focused tests in `tests-node/`, and evaluation SOP documents in `sop/`. The legacy evaluator retains its configurable OpenAI-compatible executor. The unified automation module uses the user-approved Codex SDK with configurable Responses base URL, model, and encrypted API key; default model is deepseek-flash-1017. Never modify global Codex configuration.
- The former Kooboo runtime resources under `src/api/`, `src/code/`, and `src/job/`, native binding types, and obsolete site publishing scripts have been removed. Consult Git history for the old implementation. Do not restore Kooboo runtime resources or use `kb push` as the deployment path.
- Keep runtime data, API keys, environment tokens, `.env`, `.data/`, vault keys, and generated `kooboo.d.ts` out of Git and logs. Preserve the existing local `.data/` and its master key when copying source from a temporary workspace.
- Local configuration is encrypted inside `.data/`; backups must include both data and its master key. Do not overwrite existing runtime configuration or regenerate its key during build.
- The frontend establishes its local HttpOnly session automatically; do not add a manual entry or login screen for this local-only workspace. The default service binds to `127.0.0.1:4180`; production network deployment and user authentication require a separate design.
- Preserve stage checkpoints, source-run evidence references, versioned rules/SOP snapshots, and Admin integration contracts. Model image capability must be tested with actual image input, not a text-only connectivity check.
- Validate changes with focused tests, type checks, and build as appropriate. Do not claim real model, browser, remote, or visual acceptance from mocked tests. Browser control requires explicit user permission.

- The unified platform source is `frontend/src/views/automation/`, `server/automation/`, and `shared/automation.ts`. Preserve legacy reports and APIs. New automation runs are paused by default until enabled in settings.
- Keep input versions, published rule snapshots, site identities, cancellation confirmation, pending context, and automatic generation-to-evaluation handoff durable. Do not redeliver uncertain generation after restart. New-site and continuation flows must remain distinct.

- Show transient operation feedback (save, copy, import, publish) through the shared floating MessageHost / notify helper. Keep persistent connection failures and contextual validation errors near their controls.
