/**
 * OpenSync POC v4 — EventBus stub
 *
 * A minimal in-process event bus. Real connectors subscribe to events emitted
 * after each successful record dispatch to trigger webhook delivery, audit
 * logging, or downstream actions.
 *
 * This stub validates the emission contract and event shape without attaching
 * any real subscribers. Extend to a proper pub/sub in a later POC.
 */

// ─── Event types ──────────────────────────────────────────────────────────────

/** Per-field change descriptor emitted with every record event. */
export interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  /** connectorId that last wrote `oldValue` (from shadow_state) */
  prevSrc: string | null;
  /** connectorId that wrote `newValue` in this dispatch */
  newSrc: string;
}

export interface RecordCreatedEvent {
  type: "record.created";
  channelId: string;
  entityName: string;
  canonicalId: string;
  sourceConnectorId: string;
  targetConnectorId: string;
  batchId: string;
  /** Full canonical record values at time of emission */
  data: Record<string, unknown>;
  changes: FieldDiff[];
}

export interface RecordUpdatedEvent {
  type: "record.updated";
  channelId: string;
  entityName: string;
  canonicalId: string;
  sourceConnectorId: string;
  targetConnectorId: string;
  batchId: string;
  data: Record<string, unknown>;
  changes: FieldDiff[];
}

export type SyncEvent = RecordCreatedEvent | RecordUpdatedEvent;

export type EventHandler = (event: SyncEvent) => void | Promise<void>;

// ─── EventBus ────────────────────────────────────────────────────────────────

export class EventBus {
  private readonly handlers = new Map<SyncEvent["type"] | "*", EventHandler[]>();

  on(type: SyncEvent["type"] | "*", handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  off(type: SyncEvent["type"] | "*", handler: EventHandler): void {
    const list = this.handlers.get(type);
    if (!list) return;
    this.handlers.set(type, list.filter((h) => h !== handler));
  }

  async emit(event: SyncEvent): Promise<void> {
    const typed = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get("*") ?? [];
    for (const handler of [...typed, ...wildcard]) {
      await handler(event);
    }
  }
}
