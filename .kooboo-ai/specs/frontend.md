# Frontend

Local SPA: Vue 3 + Vite, hash routing, root entry `/`.
Source is `frontend/src`; `npm run dev` starts only a local Vite server.
`npm run build` bundles the backend and builds SPA to `frontend/dist`, then converts generated resources to `src`.
JS/CSS publish as `/assets/*`. No `src/js` or `src/css` URL prefixes.
`src/` is generated; edit backend or frontend sources and rebuild.
`src/code/evaluator-secret.ts` is private generated secret material and must not enter Git.
`npm run push` publishes generated resources to the site configured in `.env`.
