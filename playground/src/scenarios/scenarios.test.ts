/**
 * playground/src/scenarios/scenarios.test.ts
 *
 * Smoke tests for all registered playground scenarios.
 * Each scenario YAML must parse through the engine's schema without errors —
 * this is the same parse path the engine takes at boot time, so a failure here
 * means the playground won't boot.
 *
 * These run in Bun — no browser, no WASM, no sql.js required.
 *
 * SC1  every registered scenario YAML passes MappingsFileSchema.parse()
 * SC2  every registered scenario YAML produces at least one ChannelConfig
 * SC3  no scenario has an empty label
 */

import { describe, it, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { MappingsFileSchema, buildChannelsFromEntries } from "@opensync/engine";
import { scenarios } from "./index.js";

describe("playground scenarios", () => {
  for (const [key, scenario] of Object.entries(scenarios)) {
    describe(key, () => {
      let parsed: ReturnType<typeof MappingsFileSchema.parse>;

      // SC1 — YAML is valid and matches the engine schema
      it("SC1 — YAML parses without errors", () => {
        expect(() => {
          parsed = MappingsFileSchema.parse(parseYaml(scenario.yaml));
        }).not.toThrow();
      });

      // SC2 — at least one channel is produced so the engine has something to boot
      it("SC2 — produces at least one channel", () => {
        const p = MappingsFileSchema.parse(parseYaml(scenario.yaml));
        const channels = buildChannelsFromEntries(p.channels ?? [], p.mappings ?? []);
        expect(channels.length).toBeGreaterThan(0);
      });

      // SC3 — label is non-empty
      it("SC3 — label is non-empty", () => {
        expect(scenario.label.trim().length).toBeGreaterThan(0);
      });
    });
  }
});
