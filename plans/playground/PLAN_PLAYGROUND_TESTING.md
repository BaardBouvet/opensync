# Plan: Playground Browser Test Rig

**Status:** backlog  
**Date:** 2025-01-30  
**Domain:** Demo / QA  
**Scope:** playground/  
**Spec changes planned:** None — this is infrastructure only.

---

## Problem

The playground browser demo is a full event-driven sync UI. It has no automated
regression tests. Manual verification is slow and misses regressions in edge cases
(conflict resolution, real-time vs manual sync, soft-delete/restore, association
round-trips, large-scenario bootstrap).

---

## Goal

Ship a Playwright test suite that exercises the full demo in a real browser, catching
regressions before merge.

---

## Tool choice: Playwright

Playwright is preferred over Cypress for this project because:

- Runs in CI without a display server (headless Chromium/Firefox/WebKit)
- Works natively in Bun-based monorepos via `@playwright/test`
- Supports multi-tab scenarios (useful for future multi-window testing)
- `page.evaluate()` gives direct access to JS globals for state inspection
- Built-in trace viewer makes debugging flaky tests easier

---

## § 1 Setup

### § 1.1 Install

```sh
bun add -d @playwright/test
bunx playwright install chromium
```

Add to `playground/package.json` scripts:
```json
"test:e2e": "playwright test"
```

Create `playground/playwright.config.ts`:
```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env["CI"],
    timeout: 15_000,
  },
});
```

### § 1.2 Test helpers

Create `tests/e2e/helpers.ts`:
- `getCardCount(page, systemLabel)` — count cards in a cluster panel
- `getCardIds(page, systemLabel)` — read all card IDs visible in a system
- `getEventLogText(page)` — read lines from the devtools event log
- `getDbRowCount(page, table)` — click identity_map tab, count rows
- `waitForSync(page)` — wait for the `sync-idle` attribute on the root element
  (requires adding that attribute in `main.ts` after each poll cycle)
- `pressSync(page)` — click the Sync button and await `waitForSync`

### § 1.3 Helper support in main.ts

Add a testability hook in `main.ts`:

```typescript
// Set on document.body so Playwright can wait for quiescence.
document.body.dataset["syncIdle"] = "true";
// … set to "false" at start of triggerPoll, "true" at end.
```

---

## § 2 Test scenarios

All tests run against the **mock-crm-erp** scenario (fastest bootstrap) and use
real-time mode OFF so sync only happens on button click.

### § 2.1 Bootstrap sanity

```
WHEN the page loads
THEN each system shows its seeded contact count
AND the identity_map table has at least one row
```

### § 2.2 Add contact → sync → appears in all systems

```
WHEN a new contact is added to CRM via the "+" dialog
AND the sync button is pressed
THEN the contact appears in ERP within 2 polls
AND the identity_map row count increases by 1
```

### § 2.3 Edit contact → sync → propagated

```
WHEN an existing contact's name is edited in CRM
AND sync is triggered
THEN the ERP card shows the updated name
```

### § 2.4 Soft-delete → sync → hidden

```
WHEN a CRM contact is soft-deleted
AND sync is triggered
THEN the contact disappears from ERP
```

### § 2.5 Restore → sync → reappears

```
GIVEN a soft-deleted contact (from § 2.4)
WHEN it is restored
AND sync is triggered
THEN the contact reappears in ERP
```

### § 2.6 Real-time toggle

```
WHEN real-time is enabled
AND a contact is added to CRM
THEN the contact propagates within 3 seconds (no button press)
```

### § 2.7 Devtools: event log tick separators

```
WHEN sync runs twice
THEN the event log contains two "── tick #N ──" separators
```

### § 2.8 Devtools: Logs tab captures writes

```
WHEN a contact is synced from CRM to ERP
AND the Logs tab is open with ERP selected
THEN at least one syslog-row with op=insert appears
```

### § 2.9 Devtools: Clear button

```
WHEN the Clear button is clicked in the Events tab
THEN the event log is empty
```

---

## § 3 CI integration

Add to the root `.github/workflows/ci.yml` (or create it):

```yaml
e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun install
    - run: bunx playwright install --with-deps chromium
    - run: bun run --cwd playground test:e2e
    - uses: actions/upload-artifact@v4
      if: failure()
      with:
        name: playwright-traces
        path: playground/test-results/
```

---

## § 4 File layout

```
playground/
  playwright.config.ts
  tests/
    e2e/
      helpers.ts
      bootstrap.spec.ts     # § 2.1
      sync-contact.spec.ts  # § 2.2 – 2.5
      realtime.spec.ts      # § 2.6
      devtools.spec.ts      # § 2.7 – 2.9
```

---

## § 5 Out of scope (for now)

- Three-system and associations-demo scenarios (more complex, add later)
- Visual regression screenshots
- Performance budgets
- Multi-tab / conflict simulation
