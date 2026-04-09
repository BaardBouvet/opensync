/**
 * Wave connector — accounting for small businesses (waveapps.com).
 *
 * Uses the Wave public GraphQL API: https://gql.waveapps.com/graphql/public
 * Auth: OAuth2 (authorization code flow).
 *
 * Entities:
 *   customer   full CRUD
 *   product    full CRUD
 *   invoice    read + insert  (invoices are immutable once issued in accounting)
 *
 * All entities are scoped to a single Wave business (config.businessId).
 * To sync multiple businesses run multiple connector instances.
 *
 * Docs: https://developer.waveapps.com/hc/en-us/articles/360019968212
 */
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  FieldDescriptor,
  ReadBatch,
  ReadRecord,
  InsertRecord,
  InsertResult,
  UpdateRecord,
  UpdateResult,
  DeleteResult,
  OAuthConfig,
} from "@opensync/sdk";
import { AuthError, ConnectorError, RateLimitError } from "@opensync/sdk";

const GQL_URL = "https://gql.waveapps.com/graphql/public";

// ─── GraphQL helper ───────────────────────────────────────────────────────────

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

async function gql<T>(
  ctx: ConnectorContext,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await ctx.http(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403)
    throw new AuthError("Wave: authentication failed");
  if (res.status === 429)
    throw new RateLimitError("Wave: rate limit exceeded");
  if (!res.ok)
    throw new ConnectorError(`Wave API error ${res.status}`, "API_ERROR", res.status >= 500);

  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) {
    const first = body.errors[0];
    if (first.extensions?.code === "UNAUTHENTICATED")
      throw new AuthError(`Wave: ${first.message}`);
    throw new ConnectorError(
      `Wave GraphQL error: ${first.message}`,
      first.extensions?.code ?? "GQL_ERROR",
      false
    );
  }
  if (!body.data)
    throw new ConnectorError("Wave: empty response data", "EMPTY_RESPONSE");
  return body.data;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface PageInfo {
  currentPage: number;
  totalPages: number;
}

async function bizId(ctx: ConnectorContext): Promise<string> {
  const configured = ctx.config["businessId"];
  if (typeof configured === "string" && configured) return configured;

  // Auto-discover from the account and cache so subsequent calls are free.
  return ctx.state.update<string>("autoBusinessId", async (cached) => {
    if (cached) return cached;
    const Q = `query { user { businesses { edges { node { id name } } } } }`;
    const data = await gql<{
      user: { businesses: { edges: Array<{ node: { id: string; name: string } }> } };
    }>(ctx, Q);
    const businesses = data.user.businesses.edges.map((e) => e.node);
    if (businesses.length === 0)
      throw new ConnectorError(
        "Wave: no businesses found on this account",
        "CONFIG_ERROR",
        false
      );
    if (businesses.length > 1)
      throw new ConnectorError(
        `Wave: multiple businesses found (${businesses.map((b) => `${b.name} (${b.id})`).join(", ")}). ` +
          "Set config.businessId to select one.",
        "CONFIG_ERROR",
        false
      );
    return businesses[0].id;
  });
}

function maxOf(dates: (string | undefined)[]): string | undefined {
  return dates.reduce<string | undefined>(
    (m, d) => (d && (!m || d > m) ? d : m),
    undefined
  );
}

// ─── Entity: customer ─────────────────────────────────────────────────────────

interface WaveCustomer {
  id: string;
  name: string;
  email: string | null;
  address: {
    addressLine1: string | null;
    city: string | null;
    country: { code: string } | null;
  } | null;
  currency: { code: string } | null;
  modifiedAt: string;
}

const CUSTOMER_FRAGMENT = `
  id name email
  address { addressLine1 city country { code } }
  currency { code }
  modifiedAt`;

function customerToRecord(c: WaveCustomer): ReadRecord {
  return {
    id: c.id,
    data: {
      name: c.name,
      email: c.email,
      "address.line1": c.address?.addressLine1 ?? null,
      "address.city": c.address?.city ?? null,
      "address.countryCode": c.address?.country?.code ?? null,
      "currency.code": c.currency?.code ?? null,
      modifiedAt: c.modifiedAt,
    },
  };
}

const customerEntity: EntityDefinition = {
  name: "customer",

  schema: {
    name: { description: "Customer display name", type: "string", required: true },
    email: { description: "Primary contact email address", type: "string" },
    "address.line1": { description: "Street address line 1", type: "string" },
    "address.city": { description: "City", type: "string" },
    "address.countryCode": {
      description: "ISO 3166-1 alpha-2 country code (e.g. 'US', 'CA')",
      type: "string",
    },
    "currency.code": {
      description: "Default invoicing currency, ISO 4217 (e.g. 'USD')",
      type: "string",
    },
    modifiedAt: {
      description: "Last modified timestamp (ISO 8601). System-managed, used as sync watermark.",
      type: "string",
      immutable: true,
    },
  } satisfies Record<string, FieldDescriptor>,

  scopes: { read: ["account:read"], write: ["account:write"] },

  async *read(ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
    const Q = `
      query($bizId: ID!, $page: Int!, $size: Int!) {
        business(id: $bizId) {
          customers(page: $page, pageSize: $size) {
            pageInfo { currentPage totalPages }
            edges { node { ${CUSTOMER_FRAGMENT} } }
          }
        }
      }`;
    let page = 1;
    while (true) {
      const data = await gql<{
        business: {
          customers: {
            pageInfo: PageInfo;
            edges: Array<{ node: WaveCustomer }>;
          };
        };
      }>(ctx, Q, { bizId: await bizId(ctx), page, size: 100 });

      const { pageInfo, edges } = data.business.customers;
      const records = edges
        .map((e) => e.node)
        .filter((c) => !since || c.modifiedAt > since)
        .map(customerToRecord);

      yield {
        records,
        since: maxOf(edges.map((e) => e.node.modifiedAt)) ?? since,
      };

      if (page >= pageInfo.totalPages) break;
      page++;
    }
  },

  async lookup(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]> {
    const Q = `query($id: ID!) { customer(id: $id) { ${CUSTOMER_FRAGMENT} } }`;
    const results: ReadRecord[] = [];
    for (const id of ids) {
      const data = await gql<{ customer: WaveCustomer | null }>(ctx, Q, { id });
      if (data.customer) results.push(customerToRecord(data.customer));
    }
    return results;
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const M = `
      mutation($input: CustomerCreateInput!) {
        customerCreate(input: $input) {
          didSucceed
          inputErrors { code message }
          customer { ${CUSTOMER_FRAGMENT} }
        }
      }`;
    for await (const rec of records) {
      const d = rec.data;
      const input: Record<string, unknown> = {
        businessId: await bizId(ctx),
        name: d["name"],
      };
      if (d["email"]) input["email"] = d["email"];
      if (d["address.line1"] || d["address.city"] || d["address.countryCode"]) {
        input["address"] = {
          addressLine1: d["address.line1"],
          city: d["address.city"],
          countryCode: d["address.countryCode"],
        };
      }
      if (d["currency.code"]) input["currency"] = { code: d["currency.code"] };

      const res = await gql<{
        customerCreate: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
          customer: WaveCustomer | null;
        };
      }>(ctx, M, { input });

      const r = res.customerCreate;
      if (!r.didSucceed || !r.customer) {
        yield {
          id: "",
          error: r.inputErrors.map((e) => e.message).join("; ") || "customerCreate failed",
        };
      } else {
        yield { id: r.customer.id, data: r.customer as unknown as Record<string, unknown> };
      }
    }
  },

  async *update(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult> {
    const M = `
      mutation($input: CustomerPatchInput!) {
        customerPatch(input: $input) {
          didSucceed
          inputErrors { code message }
          customer { id modifiedAt }
        }
      }`;
    for await (const rec of records) {
      const d = rec.data;
      const input: Record<string, unknown> = { id: rec.id };
      if (d["name"] !== undefined) input["name"] = d["name"];
      if (d["email"] !== undefined) input["email"] = d["email"];
      if (d["address.line1"] !== undefined || d["address.city"] !== undefined) {
        input["address"] = {
          addressLine1: d["address.line1"],
          city: d["address.city"],
          countryCode: d["address.countryCode"],
        };
      }

      const res = await gql<{
        customerPatch: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
          customer: { id: string } | null;
        };
      }>(ctx, M, { input });

      const r = res.customerPatch;
      if (!r.didSucceed || !r.customer) {
        yield {
          id: rec.id,
          error: r.inputErrors.map((e) => e.message).join("; ") || "customerPatch failed",
        };
      } else {
        yield { id: r.customer.id };
      }
    }
  },

  async *delete(
    ids: AsyncIterable<string>,
    ctx: ConnectorContext
  ): AsyncIterable<DeleteResult> {
    const M = `
      mutation($input: CustomerDeleteInput!) {
        customerDelete(input: $input) {
          didSucceed
          inputErrors { code message }
        }
      }`;
    for await (const id of ids) {
      const res = await gql<{
        customerDelete: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
        };
      }>(ctx, M, { input: { id } });

      const r = res.customerDelete;
      if (!r.didSucceed) {
        yield {
          id,
          error: r.inputErrors.map((e) => e.message).join("; ") || "customerDelete failed",
        };
      } else {
        yield { id };
      }
    }
  },
};

// ─── Entity: product ──────────────────────────────────────────────────────────

interface WaveProduct {
  id: string;
  name: string;
  description: string | null;
  unitPrice: string | null; // decimal string
  isSold: boolean;
  isBought: boolean;
  modifiedAt: string;
}

const PRODUCT_FRAGMENT = `
  id name description unitPrice isSold isBought modifiedAt`;

function productToRecord(p: WaveProduct): ReadRecord {
  return {
    id: p.id,
    data: {
      name: p.name,
      description: p.description,
      unitPrice: p.unitPrice,
      isSold: p.isSold,
      isBought: p.isBought,
      modifiedAt: p.modifiedAt,
    },
  };
}

const productEntity: EntityDefinition = {
  name: "product",

  schema: {
    name: { description: "Product or service name", type: "string", required: true },
    description: { description: "Description shown on invoice line items", type: "string" },
    unitPrice: {
      description: "Default unit price as a decimal string (e.g. '49.99')",
      type: "string",
    },
    isSold: { description: "Whether this product appears on sales invoices", type: "boolean" },
    isBought: {
      description: "Whether this product appears on purchase bills",
      type: "boolean",
    },
    modifiedAt: {
      description: "Last modified timestamp (ISO 8601). System-managed, used as sync watermark.",
      type: "string",
      immutable: true,
    },
  } satisfies Record<string, FieldDescriptor>,

  scopes: { read: ["account:read"], write: ["account:write"] },

  async *read(ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
    const Q = `
      query($bizId: ID!, $page: Int!, $size: Int!) {
        business(id: $bizId) {
          products(page: $page, pageSize: $size) {
            pageInfo { currentPage totalPages }
            edges { node { ${PRODUCT_FRAGMENT} } }
          }
        }
      }`;
    let page = 1;
    while (true) {
      const data = await gql<{
        business: {
          products: {
            pageInfo: PageInfo;
            edges: Array<{ node: WaveProduct }>;
          };
        };
      }>(ctx, Q, { bizId: await bizId(ctx), page, size: 100 });

      const { pageInfo, edges } = data.business.products;
      const records = edges
        .map((e) => e.node)
        .filter((p) => !since || p.modifiedAt > since)
        .map(productToRecord);

      yield {
        records,
        since: maxOf(edges.map((e) => e.node.modifiedAt)) ?? since,
      };

      if (page >= pageInfo.totalPages) break;
      page++;
    }
  },

  async lookup(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]> {
    const Q = `query($id: ID!) { product(id: $id) { ${PRODUCT_FRAGMENT} } }`;
    const results: ReadRecord[] = [];
    for (const id of ids) {
      const data = await gql<{ product: WaveProduct | null }>(ctx, Q, { id });
      if (data.product) results.push(productToRecord(data.product));
    }
    return results;
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const M = `
      mutation($input: ProductCreateInput!) {
        productCreate(input: $input) {
          didSucceed
          inputErrors { code message }
          product { ${PRODUCT_FRAGMENT} }
        }
      }`;
    for await (const rec of records) {
      const d = rec.data;
      const input: Record<string, unknown> = { businessId: await bizId(ctx), name: d["name"] };
      if (d["description"] !== undefined) input["description"] = d["description"];
      if (d["unitPrice"] !== undefined) input["unitPrice"] = d["unitPrice"];
      if (d["isSold"] !== undefined) input["isSold"] = d["isSold"];
      if (d["isBought"] !== undefined) input["isBought"] = d["isBought"];

      const res = await gql<{
        productCreate: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
          product: WaveProduct | null;
        };
      }>(ctx, M, { input });

      const r = res.productCreate;
      if (!r.didSucceed || !r.product) {
        yield {
          id: "",
          error: r.inputErrors.map((e) => e.message).join("; ") || "productCreate failed",
        };
      } else {
        yield { id: r.product.id, data: r.product as unknown as Record<string, unknown> };
      }
    }
  },

  async *update(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult> {
    const M = `
      mutation($input: ProductPatchInput!) {
        productPatch(input: $input) {
          didSucceed
          inputErrors { code message }
          product { id modifiedAt }
        }
      }`;
    for await (const rec of records) {
      const d = rec.data;
      const input: Record<string, unknown> = { id: rec.id };
      if (d["name"] !== undefined) input["name"] = d["name"];
      if (d["description"] !== undefined) input["description"] = d["description"];
      if (d["unitPrice"] !== undefined) input["unitPrice"] = d["unitPrice"];
      if (d["isSold"] !== undefined) input["isSold"] = d["isSold"];
      if (d["isBought"] !== undefined) input["isBought"] = d["isBought"];

      const res = await gql<{
        productPatch: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
          product: { id: string } | null;
        };
      }>(ctx, M, { input });

      const r = res.productPatch;
      if (!r.didSucceed || !r.product) {
        yield {
          id: rec.id,
          error: r.inputErrors.map((e) => e.message).join("; ") || "productPatch failed",
        };
      } else {
        yield { id: r.product.id };
      }
    }
  },

  async *delete(
    ids: AsyncIterable<string>,
    ctx: ConnectorContext
  ): AsyncIterable<DeleteResult> {
    // Wave archives products rather than hard-deleting them.
    const M = `
      mutation($input: ProductArchiveInput!) {
        productArchive(input: $input) {
          didSucceed
          inputErrors { code message }
        }
      }`;
    for await (const id of ids) {
      const res = await gql<{
        productArchive: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
        };
      }>(ctx, M, { input: { id } });

      const r = res.productArchive;
      if (!r.didSucceed) {
        yield {
          id,
          error: r.inputErrors.map((e) => e.message).join("; ") || "productArchive failed",
        };
      } else {
        yield { id };
      }
    }
  },
};

// ─── Entity: invoice ──────────────────────────────────────────────────────────

interface WaveInvoiceItem {
  description: string | null;
  quantity: string;
  unitPrice: string;
  product: { id: string } | null;
}

interface WaveInvoice {
  id: string;
  title: string | null;
  status: string;
  customer: { id: string; name: string };
  createdAt: string;
  modifiedAt: string;
  amountDue: { value: string; currency: { code: string } } | null;
  items: WaveInvoiceItem[];
}

const INVOICE_FRAGMENT = `
  id title status
  customer { id name }
  createdAt modifiedAt
  amountDue { value currency { code } }
  items { description quantity unitPrice product { id } }`;

function invoiceToRecord(inv: WaveInvoice): ReadRecord {
  return {
    id: inv.id,
    data: {
      title: inv.title,
      status: inv.status,
      "customer.id": inv.customer.id,
      "customer.name": inv.customer.name,
      "amountDue.value": inv.amountDue?.value ?? null,
      "amountDue.currencyCode": inv.amountDue?.currency.code ?? null,
      items: inv.items,
      createdAt: inv.createdAt,
      modifiedAt: inv.modifiedAt,
    },
  };
}

const invoiceEntity: EntityDefinition = {
  name: "invoice",

  schema: {
    title: { description: "Invoice title / memo line", type: "string" },
    status: {
      description:
        "Invoice lifecycle status set by Wave: DRAFT | SAVED | VIEWED | PARTIAL | PAID | OVERDUE | UNPAID",
      type: "string",
      immutable: true,
    },
    "customer.id": {
      description: "ID of the Wave customer this invoice belongs to",
      type: "string",
      entity: "customer",
      required: true,
    },
    "customer.name": {
      description: "Customer name (populated on read; ignored on create)",
      type: "string",
      immutable: true,
    },
    "amountDue.value": {
      description: "Outstanding amount as a decimal string",
      type: "string",
      immutable: true,
    },
    "amountDue.currencyCode": {
      description: "Invoice currency, ISO 4217",
      type: "string",
      immutable: true,
    },
    items: {
      description:
        "Array of line items. Each object: { description?, quantity, unitPrice, productId? }",
      type: { type: "array", items: { type: "object" } },
    },
    createdAt: {
      description: "Invoice creation timestamp (ISO 8601)",
      type: "string",
      immutable: true,
    },
    modifiedAt: {
      description: "Last modified timestamp (ISO 8601). System-managed, used as sync watermark.",
      type: "string",
      immutable: true,
    },
  } satisfies Record<string, FieldDescriptor>,

  scopes: { read: ["account:read"], write: ["account:write"] },
  // Invoices reference customers and may reference products on line items.
  dependsOn: ["customer", "product"],

  async *read(ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
    const Q = `
      query($bizId: ID!, $page: Int!, $size: Int!) {
        business(id: $bizId) {
          invoices(page: $page, pageSize: $size) {
            pageInfo { currentPage totalPages }
            edges { node { ${INVOICE_FRAGMENT} } }
          }
        }
      }`;
    let page = 1;
    while (true) {
      const data = await gql<{
        business: {
          invoices: {
            pageInfo: PageInfo;
            edges: Array<{ node: WaveInvoice }>;
          };
        };
      }>(ctx, Q, { bizId: await bizId(ctx), page, size: 50 });

      const { pageInfo, edges } = data.business.invoices;
      const records = edges
        .map((e) => e.node)
        .filter((inv) => !since || inv.modifiedAt > since)
        .map(invoiceToRecord);

      yield {
        records,
        since: maxOf(edges.map((e) => e.node.modifiedAt)) ?? since,
      };

      if (page >= pageInfo.totalPages) break;
      page++;
    }
  },

  async lookup(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]> {
    const Q = `query($id: ID!) { invoice(id: $id) { ${INVOICE_FRAGMENT} } }`;
    const results: ReadRecord[] = [];
    for (const id of ids) {
      const data = await gql<{ invoice: WaveInvoice | null }>(ctx, Q, { id });
      if (data.invoice) results.push(invoiceToRecord(data.invoice));
    }
    return results;
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const M = `
      mutation($input: InvoiceCreateInput!) {
        invoiceCreate(input: $input) {
          didSucceed
          inputErrors { code message }
          invoice { id createdAt modifiedAt status }
        }
      }`;
    for await (const rec of records) {
      const d = rec.data;
      const rawItems = (d["items"] as Record<string, unknown>[] | undefined) ?? [];
      const input: Record<string, unknown> = {
        businessId: await bizId(ctx),
        customerId: d["customer.id"],
        // Wave defaults to DRAFT; allow the caller to override.
        status: d["status"] ?? "DRAFT",
        items: rawItems.map((item) => ({
          description: item["description"],
          quantity: item["quantity"],
          unitPrice: item["unitPrice"],
          ...(item["productId"] ? { productId: item["productId"] } : {}),
        })),
      };
      if (d["title"]) input["title"] = d["title"];

      const res = await gql<{
        invoiceCreate: {
          didSucceed: boolean;
          inputErrors: Array<{ message: string }>;
          invoice: {
            id: string;
            createdAt: string;
            modifiedAt: string;
            status: string;
          } | null;
        };
      }>(ctx, M, { input });

      const r = res.invoiceCreate;
      if (!r.didSucceed || !r.invoice) {
        yield {
          id: "",
          error: r.inputErrors.map((e) => e.message).join("; ") || "invoiceCreate failed",
        };
      } else {
        yield { id: r.invoice.id, data: r.invoice as unknown as Record<string, unknown> };
      }
    }
  },
  // Invoices are intentionally immutable after creation — no update() or delete().
};

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "waveapps",
    version: "0.1.0",
    auth: {
      type: "oauth2",
      // account:read is the minimum; write scopes are unioned at channel setup.
      scopes: ["account:read"],
    },
    allowedHosts: ["gql.waveapps.com"],
    configSchema: {
      businessId: {
        type: "string",
        description:
          "Wave business ID. Leave blank when the account has exactly one business — it will be" +
          " discovered automatically. Required when the account has multiple businesses.",
        required: false,
      },
    },
  },

  getOAuthConfig(_config: Record<string, unknown>): OAuthConfig {
    return {
      authorizationUrl: "https://api.waveapps.com/oauth2/authorize/",
      tokenUrl: "https://api.waveapps.com/oauth2/token/",
    };
  },

  getEntities(_ctx: ConnectorContext): EntityDefinition[] {
    return [customerEntity, productEntity, invoiceEntity];
  },

  async healthCheck(ctx: ConnectorContext) {
    const Q = `query { user { id defaultEmail } }`;
    const data = await gql<{ user: { id: string; defaultEmail: string } }>(ctx, Q);
    return {
      healthy: true,
      details: { userId: data.user.id, email: data.user.defaultEmail },
    };
  },
};

export default connector;
