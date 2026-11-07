# Frontend

The active application is Vue 3 + Vite with an independent Node.js server. The SPA uses hash routing and root entry `/`; source lives in `frontend/src/` and shared application types live in `shared/`.

`npm run dev` starts the Node API and background worker at `http://127.0.0.1:4180`. For frontend hot reload, run `npm run dev:web` separately; Vite listens on `http://127.0.0.1:4181` and proxies `/api` to the Node server.

`npm run build` writes frontend assets into `dist/` and compiles readable Node modules into `dist-server/`. `npm start` serves the SPA and API together. Former Kooboo runtime resources have been removed; the old implementation is available in Git history.

Keep the existing page layout, task stages, execution history, screenshot comparison, and site-preview iframe. The frontend establishes the HttpOnly local session automatically through `POST /api/login` when a request receives 401, shares concurrent connection attempts and retries each request at most once. There is no manual entry screen or logout control. Local session checks and trusted-origin restrictions remain in the backend; this is not production user authentication.

Settings include a single configurable image- and tool-capable Chat Completions model, Kooboo environments, review threshold, queue pause, a stage budget for each viewport capture and final scoring, and bounded capture attempts. Keep secret fields empty after saving and retain the existing secret unless explicitly replaced or cleared. Model tests submit actual pixels and validate function calls and tool result consumption.

The active backend is `server/`, contracts are `shared/`, evaluation instructions are `sop/`, and focused tests are `tests-node/`. The former `src/api/`, `src/code/`, `src/job/`, native binding types, and obsolete site publishing scripts are no longer part of the current tree. `kb push` is not part of the current development or deployment flow.

## Unified automation

The five main pages are Resources, Tasks (default), Reports, Rules, and Settings. They live under `frontend/src/views/automation/`. The sidebar persists collapsed state; icons use Lucide. `components/BaseSelect.vue` wraps the native select for keyboard semantics with consistent text / arrow padding. Resources use checkbox multi-selection for batch creation.

New tasks use `/api/automation/` and are separate from legacy evaluation history, which remains accessible via `/legacy-evaluations`. New generation is driven by the existing Kooboo AI Chat frontend loop; evaluation uses Codex SDK with an isolated runtime home. The management tab does not own execution. See `docs/UNIFIED_AUTOMATION.md` for current validation boundaries.

Transient save/copy/import/publish feedback uses `lib/notifications.ts` and the single `components/MessageHost.vue` mounted in App. Messages float above the layout and expire automatically; persistent connection failures and form validation errors remain contextual. Settings model panels use an explicit vertical stack to separate fields, buttons and explanatory text.

The evaluation model tab uses one card and one save action for model name, effective API base URL, and API Key. Empty keys retain the stored secret. Save model settings without overwriting queue limits, prompts, environment credentials or legacy executor endpoint/name. Testing requires saved changes. The full evaluation-conversation UI is deferred until the current real workflow is reviewed.


The internal AI followup tab configures an independent concurrency/budget and editable SOP. Recovery keeps the original task, site, version and artifacts; manual new-round followup is separate. Tasks show following-up/interrupted states, action history and actionable interruption details. The persistent notification inbox uses the existing floating notify helper for new items; optional desktop notifications require an open page. Generation requires the opt-in Kooboo AI Chat automation bridge. See the unified guide for deployment and real-run validation boundaries.

Keep application UI aligned and functional: notification and sidebar footer icons follow the main navigation icon and text columns in expanded mode and remain centered when collapsed. Task interruption panels use the regular card surface without a decorative colored side border; distinguish the reason, next actions, and optional history through spacing and typography.

Task details are divided into Overview, Evaluation results, Execution history, Usage/cost, and Input/configuration. Delivery appears only for an applicable configured connection or an existing delivery record. Keep the shared header compact, with task identity, state and contextual actions; full followup output and billing details belong in their own sections. Task links default to Overview; report links carry `?tab=report`. Preserve a selected tab during polling and support direct links, keyboard focus, loading, empty and retry states.

The UI polls `/tasks/:id/summary`, not the legacy full task detail. Usage and execution history use server pagination (20 rows by default); sections load only while selected. Report screenshots are mounted only when opened and the full gallery has 12 images per page. Compact task lists and notifications omit complete Agent messages, evidence arrays and raw usage; complete historical data remains accessible through the existing APIs. Use shared Disclosure and TablePagination controls with Lucide icons. Reusable AI App generation/review guidance is maintained in `sop/app-ui-information-hierarchy.md`; published rule snapshots remain immutable.
