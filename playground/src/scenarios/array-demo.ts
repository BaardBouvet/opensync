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
  yaml: `
channels:
  - id: orders
    identityFields: [ref]
  - id: order-lines
    # Compound group: both orderRef AND lineNo must match to link records.
    identityGroups:
      - fields: [orderRef, lineNo]

conflict:
  strategy: lww

mappings:
  # ── Channel 1: orders ──────────────────────────────────────────────────────
  - connector: erp
    entity: orders
    channel: orders
    fields:
      - { source: orderRef, target: ref    }
      - { source: total,    target: total  }
      - { source: status,   target: status }
      - { source: date,     target: date   }

  - connector: webshop
    entity: purchases
    channel: orders
    fields:
      - { source: purchaseRef, target: ref    }
      - { source: amount,      target: total  }
      - { source: state,       target: status }

  # ── Channel 2: order-lines (array expansion) ───────────────────────────────
  # Webshop member FIRST — ensures array_parent_map is populated before erp ingest.

  # Parent source descriptor — defines the read source for the child
  - name: webshop_purchases_src
    connector: webshop
    entity: purchases
    channel: order-lines

  # Child member — expands lines array from parent purchases records
  - parent: webshop_purchases_src
    entity: order_lines
    channel: order-lines
    array_path: lines
    element_key: lineNo
    parent_fields:
      purchaseRef: purchaseRef
    fields:
      - { source: lineNo,      target: lineNo    }
      - { source: sku,         target: sku       }
      - { source: quantity,    target: qty       }
      - { source: linePrice,   target: unitPrice }
      - { source: purchaseRef, target: orderRef  }

  - connector: erp
    entity: orderLines
    channel: order-lines
    fields:
      - { source: lineNo,    target: lineNo    }
      - { source: sku,       target: sku       }
      - { source: qty,       target: qty       }
      - { source: unitPrice, target: unitPrice }
      - { source: orderRef,  target: orderRef  }
`,
};

export default scenario;
