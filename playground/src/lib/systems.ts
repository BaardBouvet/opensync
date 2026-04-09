// Fixed CRM / ERP / HR seed used by every browser-demo scenario.
// Scenarios define only channels + conflict; the connector data is always
// this fixture so the user can focus on experimenting with channel configs.
import type { ReadRecord, FieldDescriptor } from "@opensync/sdk";

export type EntitySeedMap = Record<string, Record<string, ReadRecord[]>>;

/** Per-entity field declarations — full FieldDescriptor including description, type, and example.
 *  FK fields also carry `entity` so the engine auto-synthesises associations from plain string
 *  values in `data`.  Spec: plans/connectors/PLAN_SCHEMA_REF_AUTOSYNTH.md §3.1 */
export type EntitySchemaMap = Record<string, Record<string, Record<string, FieldDescriptor>>>;

// Spec: specs/playground.md §11.15 — explicit schema used by the lineage field preview
export const FIXED_SCHEMAS: EntitySchemaMap = {
  crm: {
    companies: {
      name:   { type: "string", description: "Company display name", example: "Acme Corp" },
      domain: { type: "string", description: "Primary web domain", example: "acme.com" },
    },
    contacts: {
      name:               { type: "string", description: "Full name", example: "Alice Liddell" },
      email:              { type: "string", description: "Work email address", example: "alice@example.com" },
      primaryCompanyId:   { type: "string", entity: "companies", description: "Main company this contact belongs to", example: "co1" },
      secondaryCompanyId: { type: "string", entity: "companies", description: "Secondary company affiliation", example: "co2" },
    },
  },
  erp: {
    accounts: {
      accountName: { type: "string", description: "Account display name", example: "Acme Corp" },
      website:     { type: "string", description: "Account website", example: "acme.com" },
    },
    employees: {
      fullName: { type: "string", description: "Employee full name", example: "Alice Liddell" },
      email:    { type: "string", description: "Work email address", example: "alice@example.com" },
      orgId:    { type: "string", entity: "accounts", description: "Parent account reference", example: "acc1" },
    },
    orders: {
      orderRef: { type: "string", description: "Human-readable order reference", example: "ORD-1001" },
      total:    { type: "number", description: "Order total in account currency", example: 299.90 },
      status:   { type: "string", description: "Order lifecycle status", example: "shipped" },
      date:     { type: "string", description: "ISO 8601 order date", example: "2026-03-15" },
    },
    orderLines: {
      lineNo:    { type: "string", description: "Line item identifier within the order", example: "L01" },
      sku:       { type: "string", description: "Product stock-keeping unit code", example: "SKU-001" },
      qty:       { type: "number", description: "Quantity ordered", example: 5 },
      unitPrice: { type: "number", description: "Unit price at time of purchase", example: 29.99 },
      orderRef:  { type: "string", description: "Parent order reference", example: "ORD-1001" },
    },
    items: {
      sku:      { type: "string", description: "Product stock-keeping unit code", example: "SKU-001" },
      itemName: { type: "string", description: "Product display name", example: "Widget A" },
      price:    { type: "number", description: "List price", example: 29.99 },
    },
  },
  hr: {
    orgs: {
      orgName: { type: "string", description: "Organisation display name", example: "Globex Inc" },
      site:    { type: "string", description: "Organisation website", example: "globex.com" },
    },
    people: {
      displayName: { type: "string", description: "Person display name", example: "Bob Martin" },
      email:       { type: "string", description: "Work email address", example: "bob@example.com" },
      orgRef:      { type: "string", entity: "orgs", description: "Organisation this person belongs to", example: "org1" },
    },
  },
  webshop: {
    purchases: {
      purchaseRef:   { type: "string", description: "Purchase reference code", example: "ORD-1001" },
      accountDomain: { type: "string", description: "Buyer account domain", example: "acme.com" },
      amount:        { type: "number", description: "Total purchase amount", example: 299.90 },
      state:         { type: "string", description: "Purchase lifecycle state", example: "shipped" },
      couponCode:    { type: "string", description: "Applied discount coupon code (null if none)", example: "SAVE10" },
      lines:         { type: { type: "array" }, description: "Individual line items in this purchase" },
    },
  },
};

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
        // Alice has two typed company links stored as plain FK strings in data.
        // Spec: plans/playground/PLAN_HUBSPOT_TRIPLETEX_ASSOC_DEMO.md § 3.1
        data: { name: "Alice Liddell", email: "alice@example.com", primaryCompanyId: "co1", secondaryCompanyId: "co2" },
      },
      {
        id: "c2",
        data: { name: "Bob Martin",  email: "bob@example.com",  primaryCompanyId: "co2" },
      },
      {
        id: "c3",
        data: { name: "Carol White", email: "carol@example.com", primaryCompanyId: "co3" },
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
        data: { fullName: "Alice Liddell", email: "alice@example.com", orgId: "acc1" },
      },
      {
        id: "e2",
        data: { fullName: "Bob Martin",    email: "bob@example.com",   orgId: "acc2" },
      },
    ],
    orders: [
      { id: "ord1", data: { orderRef: "ORD-1001", total: 299.90, status: "shipped", date: "2026-03-15" } },
      { id: "ord2", data: { orderRef: "ORD-1002", total: 149.95, status: "pending", date: "2026-04-01" } },
    ],
    // orderLines starts empty — populated by the engine from webshop expansion on warmup.
    orderLines: [],
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
        data: { displayName: "Bob Martin",  email: "bob@example.com",  orgRef: "org1" },
      },
      {
        id: "p2",
        data: { displayName: "Carol White", email: "carol@example.com", orgRef: "org2" },
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
