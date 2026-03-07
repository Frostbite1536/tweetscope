# Web UI

React 18 + Vite frontend for tweetscope.

## Run

```bash
npm install
npm run dev
```

The dev server runs on `http://localhost:5174` and proxies `/api` to the Hono API on port `3000`.

## Current route shell

- `/` -> dashboard
- `/new` -> new collection / import flow
- `/datasets/:dataset/explore/:scope` -> main explore UI

`single_profile` mode redirects `/` to one public scope. The separate Vite `read_only` build swaps the app for a docs iframe.

## Architecture pointers

- App shell: `src/App.jsx`
- Route pages: `src/pages/`
- Explore surface: `src/pages/V2/FullScreenExplore.jsx`
- Scope/filter state: `src/contexts/ScopeContext.tsx`, `src/contexts/FilterContext.jsx`
- API wrappers: `src/lib/apiService.ts`

See the repo-level [DEVELOPMENT.md](../DEVELOPMENT.md) for the broader system architecture and API/pipeline notes.
