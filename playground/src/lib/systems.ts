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
};

/** Connector IDs available in every scenario. */
export const FIXED_SYSTEMS = ["crm", "erp", "hr"] as const;
