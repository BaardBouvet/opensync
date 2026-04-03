/**
 * SPARQL / RDF connector — any SPARQL 1.1-compliant triplestore.
 *
 * Reads and writes schema.org-typed resources as two entities:
 *   person       (https://schema.org/Person)
 *   organization (https://schema.org/Organization)
 *
 * Record IDs are full IRIs (e.g. "https://example.org/people/abc123"). This is
 * the natural identity model for RDF: every resource is named by a URI. When
 * the engine establishes an association, the `predicate` field carries the full
 * predicate URI — e.g. "https://schema.org/worksFor" for person → organization.
 *
 * Compatible endpoints: Apache Jena Fuseki, Stardog, GraphDB, AWS Neptune,
 * Blazegraph, Virtuoso, QLever, and any other SPARQL 1.1 service.
 *
 * Read:  POST {queryEndpoint}  Content-Type: application/sparql-query
 *                              Accept:       application/sparql-results+json
 * Write: POST {updateEndpoint} Content-Type: application/sparql-update
 *
 * Watermark: dcterms:modified on each subject (ISO 8601 datetime literal).
 * Pagination: SPARQL LIMIT / OFFSET over subjects ordered by modification time.
 *
 * Auth: HTTP Basic (username + password in config) or open (no credentials).
 *
 * Docs:
 *   SPARQL 1.1:  https://www.w3.org/TR/sparql11-overview/
 *   SPARQL proto: https://www.w3.org/TR/sparql11-protocol/
 *   schema.org:  https://schema.org
 *   dcterms:     https://www.dublincore.org/specifications/dublin-core/dcmi-terms/
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
} from "@opensync/sdk";
import { AuthError, ConnectorError, ValidationError } from "@opensync/sdk";

// ─── RDF namespace constants ──────────────────────────────────────────────────

const SCHEMA = "https://schema.org/";
const DCTERMS = "http://purl.org/dc/terms/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// ─── SPARQL result types ──────────────────────────────────────────────────────

interface SparqlBinding {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

type BindingRow = Record<string, SparqlBinding | undefined>;

interface SparqlResults {
  results: { bindings: BindingRow[] };
}

// ─── SPARQL helpers ───────────────────────────────────────────────────────────

function getQueryEndpoint(ctx: ConnectorContext): string {
  const ep = ctx.config["queryEndpoint"];
  if (typeof ep !== "string" || !ep)
    throw new ValidationError("config.queryEndpoint must be a non-empty string");
  return ep;
}

function getUpdateEndpoint(ctx: ConnectorContext): string {
  const ep = ctx.config["updateEndpoint"];
  if (typeof ep !== "string" || !ep)
    throw new ConnectorError(
      "config.updateEndpoint is required for write operations",
      "CONFIG_ERROR",
      false
    );
  return ep;
}

/** Wrap a triple/graph pattern in a GRAPH clause if config.graphUri is set. */
function inGraph(ctx: ConnectorContext, pattern: string): string {
  const g = ctx.config["graphUri"] as string | undefined;
  return g ? `GRAPH <${g}> {\n${pattern}\n}` : pattern;
}

async function sparqlSelect(ctx: ConnectorContext, query: string): Promise<BindingRow[]> {
  const res = await ctx.http(getQueryEndpoint(ctx), {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      Accept: "application/sparql-results+json",
    },
    body: query,
  });
  if (res.status === 401 || res.status === 403)
    throw new AuthError("SPARQL: authentication failed");
  if (!res.ok)
    throw new ConnectorError(
      `SPARQL query failed with status ${res.status}`,
      "QUERY_ERROR",
      res.status >= 500
    );
  const body = (await res.json()) as SparqlResults;
  return body.results.bindings;
}

async function sparqlUpdate(ctx: ConnectorContext, statement: string): Promise<void> {
  const res = await ctx.http(getUpdateEndpoint(ctx), {
    method: "POST",
    headers: { "Content-Type": "application/sparql-update" },
    body: statement,
  });
  if (res.status === 401 || res.status === 403)
    throw new AuthError("SPARQL: authentication failed");
  if (!res.ok)
    throw new ConnectorError(
      `SPARQL update failed with status ${res.status}`,
      "UPDATE_ERROR",
      res.status >= 500
    );
}

// ─── RDF term helpers ─────────────────────────────────────────────────────────

/** Escape a string literal value for embedding in a SPARQL query. */
function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Serialise a JavaScript value as a SPARQL RDF term.
 * - URLs (http/https) → IRI: <url>
 * - strings          → plain literal: "value"
 * - numbers          → xsd:decimal literal
 * - booleans         → xsd:boolean literal
 * Returns null for null / undefined / unsupported types.
 */
function toRdfTerm(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://"))
      return `<${value}>`;
    return `"${escapeLiteral(value)}"`;
  }
  if (typeof value === "number")
    return `"${value}"^^<${XSD}decimal>`;
  if (typeof value === "boolean")
    return `"${String(value)}"^^<${XSD}boolean>`;
  return null;
}

/**
 * Mint a fresh IRI for a new resource.
 * Uses config.baseUri (default: https://opensync.example/) + entity type + timestamp+random suffix.
 */
function mintIri(ctx: ConnectorContext, entityType: string): string {
  const base = (ctx.config["baseUri"] as string | undefined) ?? "https://opensync.example/";
  // Combine timestamp (base-36) and random digits for a collision-resistant suffix.
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${base}${entityType}/${suffix}`;
}

// ─── Entity factory ───────────────────────────────────────────────────────────

/** Descriptor for one RDF property on an entity. */
interface PropDef {
  /** Full predicate IRI, e.g. "https://schema.org/name". */
  predicate: string;
  description: string;
  type?: FieldDescriptor["type"];
  required?: boolean;
  immutable?: boolean;
  /**
   * If set, values of this property that are IRIs are treated as references to
   * another entity. The engine creates an Association with predicate = this
   * property's predicate IRI (a full URI, as recommended by the SDK).
   */
  refEntity?: string;
}

/**
 * Build an EntityDefinition that reads/writes a single RDF type from a SPARQL endpoint.
 *
 * The entity uses dcterms:modified for incremental sync. If the triplestore does
 * not maintain this predicate, every sync will be a full scan.
 *
 * SPARQL SELECT pagination uses LIMIT/OFFSET ordered by modification time so that
 * the watermark advances monotonically across pages.
 */
function makeRdfEntity(opts: {
  name: string;
  typeUri: string;
  props: Record<string, PropDef>;
  dependsOn?: string[];
}): EntityDefinition {
  const { name, typeUri, props, dependsOn } = opts;
  const propEntries = Object.entries(props);
  const modPred = `<${DCTERMS}modified>`;

  // ── Read helpers ────────────────────────────────────────────────────────────

  function rowToRecord(row: BindingRow): ReadRecord | null {
    const idBinding = row["id"];
    // Blank nodes have no stable IRI — skip them.
    if (!idBinding || idBinding.type !== "uri") return null;

    const id = idBinding.value;
    const data: Record<string, unknown> = {};
    const associations: NonNullable<ReadRecord["associations"]> = [];

    for (const [field, def] of propEntries) {
      const b = row[field];
      if (!b) continue;
      data[field] = b.value;
      // When the value is an IRI and the property is declared as a reference,
      // emit an Association whose predicate is the full property URI.
      if (def.refEntity && b.type === "uri") {
        associations.push({
          predicate: def.predicate,
          targetEntity: def.refEntity,
          targetId: b.value,
        });
      }
    }

    const rec: ReadRecord = { id, data };
    if (associations.length > 0) rec.associations = associations;
    return rec;
  }

  // ── Write helpers ────────────────────────────────────────────────────────────

  /** Produce SPARQL triple lines for an IRI subject, preserving type and dcterms:modified. */
  function buildTriples(iri: string, data: Record<string, unknown>): string[] {
    const now = new Date().toISOString();
    const lines: string[] = [
      `<${iri}> a <${typeUri}> .`,
      `<${iri}> ${modPred} "${escapeLiteral(now)}"^^<${XSD}dateTime> .`,
    ];
    for (const [field, def] of propEntries) {
      const term = toRdfTerm(data[field]);
      if (term !== null) lines.push(`<${iri}> <${def.predicate}> ${term} .`);
    }
    return lines;
  }

  // ── EntityDefinition ────────────────────────────────────────────────────────

  return {
    name,
    dependsOn,

    schema: Object.fromEntries(
      propEntries.map(([field, def]) => [
        field,
        {
          description: def.description,
          type: def.type,
          required: def.required,
          immutable: def.immutable,
        } satisfies FieldDescriptor,
      ])
    ),

    async *read(ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
      const PAGE_SIZE = 200;
      const selectVars = propEntries.map(([f]) => `?${f}`).join(" ");
      const optionals = propEntries
        .map(([f, d]) => `    OPTIONAL { ?id <${d.predicate}> ?${f} }`)
        .join("\n");

      // dcterms:modified is fetched as a separate variable to serve as the watermark.
      const sinceFilter = since
        ? `FILTER(!BOUND(?_mod) || STR(?_mod) > "${escapeLiteral(since)}")`
        : "";

      let offset = 0;
      while (true) {
        const graphPattern = `
    ?id a <${typeUri}> .
${optionals}
    OPTIONAL { ?id ${modPred} ?_mod }
`;
        const query = `
SELECT DISTINCT ?id ${selectVars} ?_mod WHERE {
  ${inGraph(ctx, graphPattern)}
  ${sinceFilter}
}
ORDER BY ASC(?_mod) ASC(STR(?id))
LIMIT ${PAGE_SIZE}
OFFSET ${offset}`;

        const rows = await sparqlSelect(ctx, query);
        if (rows.length === 0) break;

        const records: ReadRecord[] = [];
        let maxMod: string | undefined = since;

        for (const row of rows) {
          const rec = rowToRecord(row);
          if (!rec) continue;
          records.push(rec);
          const mod = row["_mod"]?.value;
          if (mod && (!maxMod || mod > maxMod)) maxMod = mod;
        }

        yield { records, since: maxMod };

        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
    },

    async lookup(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]> {
      const selectVars = propEntries.map(([f]) => `?${f}`).join(" ");
      const optionals = propEntries
        .map(([f, d]) => `    OPTIONAL { ?id <${d.predicate}> ?${f} }`)
        .join("\n");
      const values = ids.map((id) => `<${id}>`).join(" ");

      const graphPattern = `
    VALUES ?id { ${values} }
    ?id a <${typeUri}> .
${optionals}
`;
      const query = `SELECT ?id ${selectVars} WHERE { ${inGraph(ctx, graphPattern)} }`;
      const rows = await sparqlSelect(ctx, query);
      return rows.flatMap((row) => {
        const rec = rowToRecord(row);
        return rec ? [rec] : [];
      });
    },

    async *insert(
      records: AsyncIterable<InsertRecord>,
      ctx: ConnectorContext
    ): AsyncIterable<InsertResult> {
      for await (const rec of records) {
        const iri = mintIri(ctx, name);
        const triples = buildTriples(iri, rec.data).join("\n");
        await sparqlUpdate(ctx, `INSERT DATA { ${inGraph(ctx, triples)} }`);
        yield { id: iri };
      }
    },

    async *update(
      records: AsyncIterable<UpdateRecord>,
      ctx: ConnectorContext
    ): AsyncIterable<UpdateResult> {
      for await (const rec of records) {
        const iri = rec.id;
        const now = new Date().toISOString();

        // Build DELETE template (variables bound by WHERE) and WHERE clause (OPTIONALs).
        const deleteLines: string[] = [
          `<${iri}> ${modPred} ?_mod .`,
        ];
        const whereLines: string[] = [
          `OPTIONAL { <${iri}> ${modPred} ?_mod . }`,
        ];
        const insertLines: string[] = [
          `<${iri}> ${modPred} "${escapeLiteral(now)}"^^<${XSD}dateTime> .`,
        ];

        for (const [field, def] of propEntries) {
          if (!(field in rec.data)) continue; // only touch supplied fields
          const varName = `_f${propEntries.findIndex(([f]) => f === field)}`;
          deleteLines.push(`<${iri}> <${def.predicate}> ?${varName} .`);
          whereLines.push(`OPTIONAL { <${iri}> <${def.predicate}> ?${varName} . }`);
          const term = toRdfTerm(rec.data[field]);
          if (term !== null) insertLines.push(`<${iri}> <${def.predicate}> ${term} .`);
        }

        const deleteBlock = inGraph(ctx, deleteLines.join("\n"));
        const insertBlock = inGraph(ctx, insertLines.join("\n"));
        const whereBlock = inGraph(ctx, whereLines.join("\n"));

        await sparqlUpdate(
          ctx,
          `DELETE { ${deleteBlock} }\nINSERT { ${insertBlock} }\nWHERE  { ${whereBlock} }`
        );
        yield { id: iri };
      }
    },

    async *delete(
      ids: AsyncIterable<string>,
      ctx: ConnectorContext
    ): AsyncIterable<DeleteResult> {
      for await (const id of ids) {
        // Remove all triples with this subject from the graph.
        await sparqlUpdate(
          ctx,
          `DELETE WHERE { ${inGraph(ctx, `<${id}> ?_p ?_o .`)} }`
        );
        yield { id };
      }
    },
  };
}

// ─── Entities ─────────────────────────────────────────────────────────────────

const organizationEntity = makeRdfEntity({
  name: "organization",
  typeUri: `${SCHEMA}Organization`,
  props: {
    name: {
      predicate: `${SCHEMA}name`,
      description: "Organization name",
      type: "string",
      required: true,
    },
    url: {
      predicate: `${SCHEMA}url`,
      description: "Primary website URL",
      type: "string",
    },
    email: {
      predicate: `${SCHEMA}email`,
      description: "General contact email address",
      type: "string",
    },
    telephone: {
      predicate: `${SCHEMA}telephone`,
      description: "Main telephone number",
      type: "string",
    },
    foundingDate: {
      predicate: `${SCHEMA}foundingDate`,
      description: "Date the organization was founded (ISO 8601 date, e.g. '2010-03-15')",
      type: "string",
    },
    description: {
      predicate: `${SCHEMA}description`,
      description: "Short description of the organization",
      type: "string",
    },
  },
});

/** Person depends on Organization because of the worksFor association. */
const personEntity = makeRdfEntity({
  name: "person",
  typeUri: `${SCHEMA}Person`,
  dependsOn: ["organization"],
  props: {
    name: {
      predicate: `${SCHEMA}name`,
      description: "Full name",
      type: "string",
      required: true,
    },
    email: {
      predicate: `${SCHEMA}email`,
      description: "Email address",
      type: "string",
    },
    telephone: {
      predicate: `${SCHEMA}telephone`,
      description: "Phone number",
      type: "string",
    },
    birthDate: {
      predicate: `${SCHEMA}birthDate`,
      description: "Date of birth (ISO 8601 date, e.g. '1990-06-15')",
      type: "string",
    },
    jobTitle: {
      predicate: `${SCHEMA}jobTitle`,
      description: "Job title or role within their organization",
      type: "string",
    },
    worksFor: {
      predicate: `${SCHEMA}worksFor`,
      // IRI of the organization — the engine maps this to an Association whose
      // predicate field is "https://schema.org/worksFor" (a full URI).
      description:
        "IRI of the organization entity this person works for (e.g. https://example.org/org/abc1). " +
        "Stored as an RDF IRI; the engine tracks the person → organization association automatically.",
      type: "string",
      refEntity: "organization",
    },
  },
});

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "sparql",
    version: "0.1.0",
    auth: {
      // SPARQL endpoints vary: open, Bearer token, or HTTP Basic.
      // Basic credentials are handled by prepareRequest below.
      // For Bearer tokens, use auth: 'api-key' instead and set the header name to 'Authorization'.
      type: "none",
    },
    // Endpoint hostnames are user-supplied, so we cannot enumerate them here.
    allowedHosts: ["*"],
    configSchema: {
      queryEndpoint: {
        type: "string",
        description:
          "SPARQL 1.1 Protocol query endpoint URL " +
          "(e.g. http://localhost:3030/mydata/query or https://query.wikidata.org/sparql).",
        required: true,
      },
      updateEndpoint: {
        type: "string",
        description:
          "SPARQL 1.1 Protocol update endpoint URL " +
          "(e.g. http://localhost:3030/mydata/update). Omit for read-only access.",
        required: false,
      },
      graphUri: {
        type: "string",
        description:
          "Named graph IRI to scope all reads and writes " +
          "(e.g. https://example.org/mygraph). Omit to use the default graph.",
        required: false,
      },
      baseUri: {
        type: "string",
        description:
          "Base IRI used when minting IRIs for new resources " +
          "(e.g. https://example.org/). Defaults to https://opensync.example/.",
        required: false,
      },
      username: {
        type: "string",
        description: "HTTP Basic Auth username, if the endpoint requires authentication.",
        required: false,
      },
      password: {
        type: "string",
        description: "HTTP Basic Auth password.",
        required: false,
        secret: true,
      },
    },
  },

  /** Inject HTTP Basic credentials when username + password are configured. */
  async prepareRequest(req: Request, ctx: ConnectorContext): Promise<Request> {
    const username = ctx.config["username"] as string | undefined;
    const password = ctx.config["password"] as string | undefined;
    if (!username || !password) return req;
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
    return new Request(req, { headers });
  },

  getEntities(_ctx: ConnectorContext): EntityDefinition[] {
    return [organizationEntity, personEntity];
  },

  async healthCheck(ctx: ConnectorContext) {
    // ASK queries are the lightest possible SPARQL operation — just tests connectivity.
    const rows = await sparqlSelect(ctx, "ASK { ?s ?p ?o }");
    // An ASK query returns a single binding row (or empty on some endpoints).
    // Either way, reaching here without throwing means the endpoint is healthy.
    return {
      healthy: true,
      details: {
        queryEndpoint: getQueryEndpoint(ctx),
        graphUri: ctx.config["graphUri"] ?? "(default graph)",
        resultRows: rows.length,
      },
    };
  },
};

export default connector;
