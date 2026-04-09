# Playground Version Badge + Update Notification

**Status:** complete  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** Playground, Infrastructure  
**Scope:** `playground/`, `playground/vite.config.ts`  

---

## § 1 Goal

Show the current playground version in the topbar so users can refer to it in
conversation ("I'm on v0.1.0"). When a newer GitHub Release exists, show a subtle
notification with a link to the release notes so users know what to try next.

---

## § 2 Spec Changes Planned

`specs/playground.md` § 2 (Topbar) should be updated to document the version badge
and update notification once this plan is implemented.

---

## § 3 Design

### § 3.1 Inject version at build time

Vite's `define` config replaces constants at build time with no runtime overhead.
Add to `vite.config.ts`:

```ts
import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  // ...
});
```

Declare the global in a `src/env.d.ts` (or extend the existing one):

```ts
declare const __APP_VERSION__: string;
```

### § 3.2 Version badge in the topbar

Add a `<span id="app-version">` to `index.html` between the brand name and the
scenario dropdown. Populated from `__APP_VERSION__` in `main.ts` on
`DOMContentLoaded`.

Appearance: muted, small, unobtrusive — `v0.1.0` in a dim colour next to the
brand, consistent with the existing topbar style.

### § 3.3 Update check via GitHub Releases API

On page load, fetch the latest release from the GitHub Releases API:

```
https://api.github.com/repos/<owner>/<repo>/releases/latest
```

Compare the returned `tag_name` (e.g. `v0.2.0`) against `__APP_VERSION__`. If
newer, show an update notification.

**Failure modes:** the fetch is fire-and-forget; network errors are silently
swallowed. No retry, no loading state. The notification only appears when a newer
version is confirmed.

**Rate limiting:** the unauthenticated GitHub API allows 60 requests/hour per IP,
which is more than sufficient for a playground page load.

### § 3.4 Update notification

When a newer version is available, show a small banner or badge in the topbar
(right side, near the reset button). It should:

- Display the new version number: `v0.2.0 available`
- Link to the GitHub Release page (the `html_url` field from the API response),
  which contains the changelog notes extracted by `release.yml`
- Be dismissible for the session (store dismiss in `sessionStorage` so it does
  not re-appear on every scenario switch, but does re-appear on a fresh tab)
- Not block or interfere with playground use

### § 3.5 "What's new" content

The changelog notes are already present on the GitHub Release page (extracted
from `CHANGELOG.md` by `release.yml`). The notification links directly there —
no need to bundle changelog content in the playground build.

---

## § 4 What Needs to Change

| File | Change |
|------|--------|
| `playground/vite.config.ts` | Add `define: { __APP_VERSION__ }` injected from `package.json` |
| `playground/src/env.d.ts` (new or existing) | Declare `__APP_VERSION__: string` |
| `playground/index.html` | Add `<span id="app-version">` in topbar; add update notification element |
| `playground/src/main.ts` | Populate version badge; fetch latest release; render notification |
| `playground/index.html` (CSS) | Style `.version-badge` and `.update-notification` |
| `specs/playground.md` § 2 | Document version badge and update notification |

---

## § 5 Out of Scope

- Changelog rendered inline in the playground (the GitHub Release page is sufficient)
- Push notifications or polling for updates after page load (one check on load is enough)
- Authentication for the GitHub API call
