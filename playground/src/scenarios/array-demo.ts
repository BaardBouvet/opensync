// Scenario: array-demo
// ERP stores orders and order lines as flat records (old-school).
// Webshop stores purchases with an embedded `lines` array (modern/nested).
// Channel 1 syncs orders ↔ purchases bidirectionally via identity field `ref`.
// Channel 2 syncs webshop purchases.lines ↔ erp orderLines via array expansion.
//
// Webshop member is listed first in channel 2 so array_parent_map is populated
// before the ERP ingest runs in the same poll tick.
// Spec: specs/playground.md § 11.11, specs/field-mapping.md § 3.2
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "array-demo (webshop nested lines → erp flat orderLines)",
  channels: [
    // ── Channel 1: orders ────────────────────────────────────────────────────
    {
      id: "orders",
      identityFields: ["ref"],
      members: [
        {
          connectorId: "erp",
          entity: "orders",
          inbound: [
            { source: "orderRef", target: "ref" },
            { source: "total",    target: "total" },
            { source: "status",   target: "status" },
            { source: "date",     target: "date" },
          ],
          outbound: [
            { source: "orderRef", target: "ref" },
            { source: "total",    target: "total" },
            { source: "status",   target: "status" },
            { source: "date",     target: "date" },
          ],
        },
        {
          connectorId: "webshop",
          entity: "purchases",
          inbound: [
            { source: "purchaseRef",   target: "ref" },
            { source: "amount",        target: "total" },
            { source: "state",         target: "status" },
          ],
          outbound: [
            { source: "purchaseRef",   target: "ref" },
            { source: "amount",        target: "total" },
            { source: "state",         target: "status" },
          ],
        },
      ],
    },

    // ── Channel 2: order-lines (array expansion) ──────────────────────────────
    // webshop member FIRST — ensures array_parent_map is populated before erp ingest.
    {
      id: "order-lines",
      // Compound group: both orderRef AND lineNo must match to link records.
      identityGroups: [{ fields: ["orderRef", "lineNo"] }],
      members: [
        {
          connectorId: "webshop",
          entity: "order_lines",       // logical entity name (shadow state / watermarks)
          sourceEntity: "purchases",   // connector.read() is called with this name
          arrayPath: "lines",
          elementKey: "lineNo",
          parentFields: {
            // bring purchaseRef from the parent purchases record into each element
            purchaseRef: "purchaseRef",
          },
          inbound: [
            { source: "lineNo",      target: "lineNo" },
            { source: "sku",         target: "sku" },
            { source: "quantity",    target: "qty" },
            { source: "linePrice",   target: "unitPrice" },
            { source: "purchaseRef", target: "orderRef" },
          ],
          outbound: [
            { source: "sku",         target: "sku" },
            { source: "quantity",    target: "qty" },
            { source: "linePrice",   target: "unitPrice" },
            { source: "purchaseRef", target: "orderRef" },
          ],
        },
        {
          connectorId: "erp",
          entity: "orderLines",
          inbound: [
            { source: "lineNo",    target: "lineNo" },
            { source: "sku",       target: "sku" },
            { source: "qty",       target: "qty" },
            { source: "unitPrice", target: "unitPrice" },
            { source: "orderRef",  target: "orderRef" },
          ],
          outbound: [
            { source: "sku",       target: "sku" },
            { source: "qty",       target: "qty" },
            { source: "unitPrice", target: "unitPrice" },
            { source: "orderRef",  target: "orderRef" },
          ],
        },
      ],
    },
  ],
  conflict: { strategy: "lww" },
};

export default scenario;
