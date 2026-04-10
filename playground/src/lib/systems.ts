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
      name:           { type: "string", description: "Company display name", example: "Acme Corp" },
      domain:         { type: "string", description: "Primary web domain", example: "acme.com" },
      description:    { type: "string", description: "Long-form company description", example: "Acme Corp is a premier enterprise solutions provider." },
      categories:     { type: { type: "array", items: "string" }, description: "Company category tags", example: ["enterprise", "partner"] },
      isPremium:      { type: "boolean", description: "Premium customer flag", example: true },
      certifications: {
        type: {
          type: "array",
          items: { type: "object", properties: {
            code:  { type: "string", description: "Certification code", example: "ISO-9001" },
            since: { type: "string", description: "Year first certified", example: "2020" },
          } },
        },
        description: "Industry certifications held by the company",
        example: [{ code: "ISO-9001", since: "2020" }],
      },
    },
    contacts: {
      name:               { type: "string",  description: "Full name",                    example: "Alice Liddell" },
      email:              { type: "string",  description: "Work email address",           example: "alice@example.com" },
      firstName:          { type: "string",  description: "First name",                   example: "Alice" },
      lastName:           { type: "string",  description: "Last name",                    example: "Liddell" },
      phone:              { type: "string",  description: "Phone number (raw; may include formatting)", example: "(555) 100-0001" },
      status:             { type: "string",  description: "Contact status",               example: "active" },
      isVerified:         { type: "boolean", description: "Email verified flag",          example: true },
      leadScore:          { type: "number",  description: "CRM lead score (0–100)",       example: 90 },
      isDeleted:          { type: "boolean", description: "Soft-deleted flag",            example: false },
      homeStreet:         { type: "string",  description: "Home street address (embedded object demo)", example: "1 Main St" },
      homeCity:           { type: "string",  description: "Home city (embedded object demo)",          example: "Boston" },
      primaryCompanyId:   { type: "string",  entity: "companies", description: "Main company this contact belongs to", example: "co1" },
      secondaryCompanyId: { type: "string",  entity: "companies", description: "Secondary company affiliation",        example: "co2" },
    },
  },
  erp: {
    accounts: {
      accountName:    { type: "string",  description: "Account display name",   example: "Acme Corp" },
      website:        { type: "string",  description: "Account website",         example: "acme.com" },
      description:    { type: "string",  description: "Account description",     example: "Key account" },
      categories:     { type: { type: "array", items: "string" }, description: "Account category tags", example: ["key-account"] },
      isPremium:      { type: "boolean", description: "Premium account flag",    example: null },
      certifications: {
        type: {
          type: "array",
          items: { type: "object", properties: {
            code:  { type: "string", description: "Certification code", example: "SOC2" },
            since: { type: "string", description: "Year first certified", example: "2023" },
          } },
        },
        description: "Compliance certifications held by this account",
        example: [],
      },
      billing: {
        type: { type: "object", properties: {
          street: { type: "string", description: "Billing street address", example: "100 Enterprise Blvd" },
          city:   { type: "string", description: "Billing city",           example: "New York" },
        } },
        description: "Nested billing address sub-object (used by source_path demo)",
        example: { street: "100 Enterprise Blvd", city: "New York" },
      },
    },
    employees: {
      fullName:     { type: "string",  description: "Employee full name",                 example: "Alice Liddell" },
      email:        { type: "string",  description: "Work email address",                 example: "alice@example.com" },
      firstName:    { type: "string",  description: "First name",                        example: "Alice" },
      lastName:     { type: "string",  description: "Last name",                         example: "Liddell" },
      phoneNo:      { type: "string",  description: "Phone number (digits only)",        example: "5551000001" },
      emailAddress: { type: "string",  description: "Work email address (ERP field)",    example: "alice@acme.com" },
      isVerified:   { type: "boolean", description: "Email verified flag",               example: null },
      status:       { type: "string",  description: "Employment status",                 example: "active" },
      orgId:        { type: "string",  entity: "accounts", description: "Parent account reference", example: "acc1" },
    },
    orders: {
      orderRef: { type: "string", description: "Human-readable order reference", example: "ORD-1001" },
      total:    { type: "number", description: "Order total in account currency", example: 299.90 },
      status:   { type: "string", description: "Order lifecycle status", example: "shipped" },
      date:     { type: "string", description: "ISO 8601 order date", example: "2026-03-15" },
      lines: {
        type: {
          type: "array",
          items: { type: "object", properties: {
            lineNo:    { type: "string", description: "Line item identifier", example: "L01" },
            sku:       { type: "string", description: "Product SKU", example: "SKU-001" },
            qty:       { type: "number", description: "Quantity ordered", example: 5 },
            unitPrice: { type: "number", description: "Unit price at time of purchase", example: 29.99 },
            components: {
              type: {
                type: "array",
                items: { type: "object", properties: {
                  compNo:   { type: "string", description: "Component identifier", example: "C01" },
                  partCode: { type: "string", description: "Part code", example: "P-AAA" },
                  qty:      { type: "number", description: "Component quantity", example: 5 },
                } },
              },
              description: "Component sub-items for this line",
            },
          } },
        },
        description: "Embedded line items with nested component sub-arrays",
      },
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
      orgName:     { type: "string",  description: "Organisation display name",    example: "Globex Inc" },
      site:        { type: "string",  description: "Organisation website",          example: "globex.com" },
      description: { type: "string",  description: "Organisation description",      example: null },
      categories:  { type: { type: "array", items: "string" }, description: "Organisation category tags", example: ["global"] },
      isPremium:   { type: "boolean", description: "Premium organisation flag",     example: null },
    },
    people: {
      displayName:    { type: "string",  description: "Person display name",                  example: "Bob Martin" },
      email:          { type: "string",  description: "Work email address",                   example: "bob@example.com" },
      firstName:      { type: "string",  description: "First name",                           example: "Bob" },
      lastName:       { type: "string",  description: "Last name",                            example: "Martin" },
      corporateEmail: { type: "string",  description: "Corporate email (null if unassigned)", example: "bob@globex.com" },
      phone:          { type: "string",  description: "Phone (may include country code)",     example: "+1-555-100-0002" },
      isVerified:     { type: "boolean", description: "Email verified flag",                  example: null },
      orgRef:         { type: "string",  entity: "orgs", description: "Organisation this person belongs to", example: "org1" },
    },
  },
  warehouse: {
    components: {
      partCode:  { type: "string", description: "Part code",               example: "P-AAA" },
      stockQty:  { type: "number", description: "Stock quantity on hand",   example: 50 },
      ordQty:    { type: "number", description: "Quantity on this order",   example: 5 },
      orderRef:  { type: "string", description: "Parent order reference",   example: "ORD-1001" },
      lineNo:    { type: "string", description: "Parent line number",       example: "L01" },
      compNo:    { type: "string", description: "Component identifier",     example: "C01" },
    },
  },
  webshop: {
    purchases: {
      purchaseRef:   { type: "string", description: "Purchase reference code", example: "ORD-1001" },
      accountDomain: { type: "string", description: "Buyer account domain", example: "acme.com" },
      amount:        { type: "number", description: "Total purchase amount", example: 299.90 },
      state:         { type: "string", description: "Purchase lifecycle state", example: "shipped" },
      couponCode:    { type: "string", description: "Applied discount coupon code (null if none)", example: "SAVE10" },
      lines: {
        type: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lineNo:    { type: "string", description: "Line item identifier within the purchase", example: "L01" },
              sku:       { type: "string", description: "Product stock-keeping unit code",          example: "SKU-001" },
              quantity:  { type: "number", description: "Quantity ordered",                          example: 5 },
              linePrice: { type: "number", description: "Unit price at time of purchase",            example: 29.99 },
            },
          },
        },
        description: "Individual line items in this purchase",
      },
    },
  },
};

// ─── Fixed seed ───────────────────────────────────────────────────────────────

export const FIXED_SEED: EntitySeedMap = {
  crm: {
    companies: [
      { id: "co1", data: { name: "Acme Corp",  domain: "acme.com",    description: "Acme Corp is a premier enterprise and partner solutions provider with over 30 years of industry experience.", categories: ["enterprise", "partner"], isPremium: true,  certifications: [{ code: "ISO-9001", since: "2020" }] } },
      { id: "co2", data: { name: "Globex Inc", domain: "globex.com",  description: "SMB",                                                                                                        categories: ["smb"],                 isPremium: null,  certifications: [] } },
      { id: "co3", data: { name: "Initech",    domain: "initech.com", description: null,                                                                                                          categories: ["startup"],             isPremium: false, certifications: [] } },
    ],
    contacts: [
      {
        id: "c1",
        // Alice has two typed company links stored as plain FK strings in data.
        // Spec: plans/playground/PLAN_HUBSPOT_TRIPLETEX_ASSOC_DEMO.md § 3.1
        data: { name: "Alice Liddell", email: "alice@example.com", firstName: "Alice", lastName: "Liddell", phone: "(555) 100-0001",  status: "a", isVerified: true,  leadScore: 90, isDeleted: false, homeStreet: "1 Main St",   homeCity: "Boston",   primaryCompanyId: "co1", secondaryCompanyId: "co2" },
      },
      {
        id: "c2",
        data: { name: "Bob Martin",   email: "bob@example.com",   firstName: "Bob",   lastName: "Martin",  phone: "555-100-0002",    status: null,    isVerified: null,  leadScore: 72, isDeleted: true,  homeStreet: "42 Oak Ave",  homeCity: "Chicago",  primaryCompanyId: "co2" },
      },
      {
        id: "c3",
        data: { name: "Carol White",  email: "carol@example.com", firstName: "Carol", lastName: "White",   phone: "+1 555 100 0003", status: "a", isVerified: null,  leadScore: 55, isDeleted: false, homeStreet: "7 Elm Rd",    homeCity: "Seattle", primaryCompanyId: "co3" },
      },
    ],
  },
  erp: {
    accounts: [
      { id: "acc1", data: { accountName: "Acme Corp",  website: "acme.com",   description: "Key account",      categories: ["key-account"], isPremium: null, certifications: [],                                billing: { street: "100 Enterprise Blvd", city: "New York"     } } },
      { id: "acc2", data: { accountName: "Globex Inc", website: "globex.com", description: "Prospect account", categories: ["prospect"],    isPremium: null, certifications: [{ code: "SOC2", since: "2023" }], billing: { street: "200 Industrial Park",  city: "Springfield" } } },
    ],
    employees: [
      {
        id: "e1",
        data: { fullName: "Alice Liddell", email: "alice@example.com", firstName: "Alice", lastName: "Liddell", phoneNo: "5551000001", emailAddress: "alice@acme.com",  isVerified: null, status: "1",   orgId: "acc1" },
      },
      {
        id: "e2",
        data: { fullName: "Bob Martin",    email: "bob@example.com",   firstName: "Bob",   lastName: "Martin",  phoneNo: "5551000002", emailAddress: "bob@globex.com", isVerified: null, status: "2", orgId: "acc2" },
      },
    ],
    orders: [
      { id: "ord1", data: { orderRef: "ORD-1001", total: 299.90, status: "shipped", date: "2026-03-15", lines: [
        { lineNo: "L01", sku: "SKU-001", qty: 5, unitPrice: 29.99, components: [
          { compNo: "C01", partCode: "P-AAA", qty: 5  },
          { compNo: "C02", partCode: "P-BBB", qty: 10 },
        ] },
        { lineNo: "L02", sku: "SKU-002", qty: 2, unitPrice: 49.99, components: [
          { compNo: "C01", partCode: "P-CCC", qty: 2  },
        ] },
      ] } },
      { id: "ord2", data: { orderRef: "ORD-1002", total: 149.95, status: "pending", date: "2026-04-01", lines: [
        { lineNo: "L01", sku: "SKU-001", qty: 3, unitPrice: 29.99, components: [] },
      ] } },
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
      { id: "org1", data: { orgName: "Globex Inc", site: "globex.com",  description: null, categories: ["global"],   isPremium: null } },
      { id: "org2", data: { orgName: "Initech",    site: "initech.com", description: null, categories: ["regional"], isPremium: null } },
    ],
    people: [
      {
        id: "p1",
        data: { displayName: "Bob Martin",  email: "bob@example.com",   firstName: "Bob",   lastName: "Martin", corporateEmail: "bob@globex.com", phone: "+1-555-100-0002", isVerified: null,  orgRef: "org1" },
      },
      {
        id: "p2",
        data: { displayName: "Carol White", email: "carol@example.com", firstName: "Carol", lastName: "White",  corporateEmail: null,              phone: "+1-555-100-0003", isVerified: false, orgRef: "org2" },
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
  warehouse: {
    components: [
      { id: "wc1", data: { partCode: "P-AAA", stockQty: 50,  ordQty: 5,  orderRef: "ORD-1001", lineNo: "L01", compNo: "C01" } },
      { id: "wc2", data: { partCode: "P-BBB", stockQty: 200, ordQty: 10, orderRef: "ORD-1001", lineNo: "L01", compNo: "C02" } },
      { id: "wc3", data: { partCode: "P-CCC", stockQty: 80,  ordQty: 2,  orderRef: "ORD-1001", lineNo: "L02", compNo: "C01" } },
    ],
  },
};

/** Connector IDs available in every scenario. */
export const FIXED_SYSTEMS = ["crm", "erp", "hr", "webshop", "warehouse"] as const;
