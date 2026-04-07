// Fixed CRM / ERP / HR seed used by every browser-demo scenario.
// Scenarios define only channels + conflict; the connector data is always
// this fixture so the user can focus on experimenting with channel configs.
import type { ReadRecord } from "@opensync/sdk";

export type EntitySeedMap = Record<string, Record<string, ReadRecord[]>>;

// ─── Fixed seed ───────────────────────────────────────────────────────────────

export const FIXED_SEED: EntitySeedMap = {
  crm: {
    companies: [
      { id: "co1", data: { name: "Acme Corp",  domain: "acme.com"    } },
      { id: "co2", data: { name: "Globex Inc", domain: "globex.com"  } },
      { id: "co3", data: { name: "Initech",    domain: "initech.com" } },
    ],
    contacts: [
      {
        id: "c1",
        data: { name: "Alice Liddell", email: "alice@example.com" },
        associations: [{ predicate: "companyId", targetEntity: "companies", targetId: "co1" }],
      },
      {
        id: "c2",
        data: { name: "Bob Martin",   email: "bob@example.com" },
        associations: [{ predicate: "companyId", targetEntity: "companies", targetId: "co2" }],
      },
      {
        id: "c3",
        data: { name: "Carol White",  email: "carol@example.com" },
        associations: [{ predicate: "companyId", targetEntity: "companies", targetId: "co3" }],
      },
    ],
  },
  erp: {
    accounts: [
      { id: "acc1", data: { accountName: "Acme Corp",  website: "acme.com"   } },
      { id: "acc2", data: { accountName: "Globex Inc", website: "globex.com" } },
    ],
    employees: [
      {
        id: "e1",
        data: { fullName: "Alice Liddell", email: "alice@example.com" },
        associations: [{ predicate: "orgId", targetEntity: "accounts", targetId: "acc1" }],
      },
      {
        id: "e2",
        data: { fullName: "Bob Martin",    email: "bob@example.com" },
        associations: [{ predicate: "orgId", targetEntity: "accounts", targetId: "acc2" }],
      },
    ],
    orders: [
      { id: "ord1", data: { orderRef: "ORD-1001", total: 299.90, status: "shipped", date: "2026-03-15" } },
      { id: "ord2", data: { orderRef: "ORD-1002", total: 149.95, status: "pending", date: "2026-04-01" } },
    ],
    orderLines: [
      { id: "ol1", data: { orderRef: "ORD-1001", lineNo: "L01", sku: "SKU-001", qty: 5,  unitPrice: 29.99 } },
      { id: "ol2", data: { orderRef: "ORD-1001", lineNo: "L02", sku: "SKU-002", qty: 2,  unitPrice: 49.99 } },
      { id: "ol3", data: { orderRef: "ORD-1002", lineNo: "L01", sku: "SKU-001", qty: 3,  unitPrice: 29.99 } },
    ],
    items: [
      { id: "item1", data: { sku: "SKU-001", itemName: "Widget A", price: 29.99 } },
      { id: "item2", data: { sku: "SKU-002", itemName: "Widget B", price: 49.99 } },
    ],
  },
  hr: {
    orgs: [
      { id: "org1", data: { orgName: "Globex Inc", site: "globex.com"  } },
      { id: "org2", data: { orgName: "Initech",    site: "initech.com" } },
    ],
    people: [
      {
        id: "p1",
        data: { displayName: "Bob Martin",   email: "bob@example.com" },
        associations: [{ predicate: "orgRef", targetEntity: "orgs", targetId: "org1" }],
      },
      {
        id: "p2",
        data: { displayName: "Carol White",  email: "carol@example.com" },
        associations: [{ predicate: "orgRef", targetEntity: "orgs", targetId: "org2" }],
      },
    ],
  },
  webshop: {
    purchases: [
      {
        id: "pu1",
        data: {
          purchaseRef: "ORD-1001",
          accountDomain: "acme.com",
          amount: 299.90,
          state: "shipped",
          couponCode: null,
          lines: [
            { lineNo: "L01", sku: "SKU-001", quantity: 5, linePrice: 29.99 },
            { lineNo: "L02", sku: "SKU-002", quantity: 2, linePrice: 49.99 },
          ],
        },
      },
      {
        id: "pu2",
        data: {
          purchaseRef: "ORD-1002",
          accountDomain: "globex.com",
          amount: 149.95,
          state: "pending",
          couponCode: "SAVE10",
          lines: [
            { lineNo: "L01", sku: "SKU-001", quantity: 3, linePrice: 29.99 },
          ],
        },
      },
    ],
  },
};

/** Connector IDs available in every scenario. */
export const FIXED_SYSTEMS = ["crm", "erp", "hr", "webshop"] as const;
