# Agent-Assisted Development

> **Status: aspirational** — describes intended design direction, not current implementation. Nothing here is blocked on a code decision; it is deferred for prioritization.

The architecture is designed so AI coding agents can generate connectors and mappings. This isn't a future feature — it's a core design principle that shapes every interface decision.

## Why TypeScript Over Declarative Config

A key decision from the design phase: connectors are TypeScript code, not YAML declarations. This is counterintuitive — YAML seems simpler — but TypeScript is dramatically better for agent-assisted development:

1. **Agents write better code than config.** LLMs excel at generating TypeScript functions. Complex YAML schemas with custom syntax (template variables, JSONPath, conditional logic) are harder for agents to get right and harder to validate.

2. **Type errors catch mistakes instantly.** When an agent generates a connector, TypeScript's compiler catches missing methods, wrong return types, and invalid field access before anything runs. A YAML typo might not surface until runtime.

3. **Full expressiveness.** A TypeScript transform function can call external APIs, do math, run regex, handle edge cases. A declarative mapping language always hits a wall where you need an "escape hatch" back to code.

4. **IDE support for free.** Agents working in an IDE (Cursor, Copilot, Claude Code) get autocomplete on the SDK interfaces. They can see exactly what `SyncContext` provides.

## Agent Workflow: Generating a Connector

An agent (or a developer using an agent) generates a connector in this flow:

### Step 1: Provide API Documentation

Give the agent the target API's documentation (OpenAPI spec, markdown docs, or even just example curl commands) along with the SDK types.

### Step 2: Agent Generates Connector

The agent reads `@opensync/sdk` interfaces and writes a connector implementing `OpenSyncConnector`:

```
Prompt: "Here is the Fiken API documentation. Write an OpenSync connector 
for contacts and invoices. Use the SDK from @opensync/sdk."
```

The agent produces:
- `getStreams()` with entity definitions, capabilities, dependencies
- `read()` implementations with pagination
- `upsert()` with create-vs-update logic
- `prepareRequest()` if auth is non-standard

### Step 3: Validate

The connector is validated at load time by the engine (Zod schemas check metadata, TypeScript compiler checks types). The agent gets immediate feedback if something is wrong.

### Step 4: Test Against Mock Data

The agent can test the connector locally using the engine's mock infrastructure — no live API needed for initial validation.

## Agent Workflow: Generating Mappings

Mapping between two systems is the second agent-assisted workflow.

### Step 1: Show Both Sides

Give the agent sample data from both connectors (e.g. 10 records from HubSpot and 10 from Fiken).

### Step 2: Agent Proposes Mapping

The agent analyzes field names, data types, and field descriptions to propose an `EntityMapping`:

```
Prompt: "Here are sample records from our HubSpot connector and our Fiken 
connector. Propose a mapping for contact → customer. Include any necessary 
transform functions."
```

The agent produces:
```typescript
const mapping: EntityMapping = {
  sourceEntity: 'contact',
  targetEntity: 'customer',
  fields: [
    { sourceField: 'firstName', targetField: 'fullName',
      transform: (d) => ({ ...d, fullName: `${d.firstName} ${d.lastName}` }) },
    { sourceField: 'email', targetField: 'emailAddress',
      transform: (d) => ({ ...d, emailAddress: d.email?.toLowerCase() }) },
    { sourceField: 'phone', targetField: 'phoneNumber',
      transform: (d) => ({ ...d, phoneNumber: normalizePhone(d.phone) }) },
  ]
};
```

### Step 3: Semantic Hints Help

If connectors provide field descriptions (`{ "fnavn": "First name", "kto_nr": "Bank account number" }`), the agent has an easier time — especially with non-English field names like Norwegian SaaS systems.

Without descriptions, the agent still infers from data: if one system has `"fnavn": "Ola"` and another has `"firstName": "Ola"`, a modern LLM connects these instantly.

### Language Barrier

Norwegian SaaS systems (Fiken, Tripletex, Visma) often have Norwegian field names: `org_nr`, `mva_kode`, `poststed`, `kto_nr`. English-trained models can usually handle common ones but may stumble on abbreviations or domain-specific terms.

Plain-text field descriptions solve this: `{ "kto_nr": "Bank account number", "mva_kode": "VAT code" }` removes all ambiguity. No structured taxonomy needed — just describe the field in whatever language is clearest. Connector authors should add descriptions especially for non-English or domain-specific field names.

## Agent Workflow: Connector Scaffolding

The CLI provides a scaffolding command:

```
opensync create-connector my-new-saas
```

This generates:
- `connectors/my-new-saas/package.json`
- `connectors/my-new-saas/src/index.ts` — template with all required methods stubbed out
- `connectors/my-new-saas/src/__tests__/index.test.ts` — test template

The template is minimal but complete — it compiles and can be loaded by the engine. An agent fills in the actual API logic.

## Why the Architecture is Agent-Friendly

Every design choice supports agent-assisted development:

| Design Decision | Why It Helps Agents |
|----------------|-------------------|
| TypeScript interfaces (not YAML) | Agents write better code than config |
| `ctx.http` handles auth/logging/retry | Agent only writes data logic, not infrastructure |
| `ctx.state` for persistent state | Agent doesn't need to design storage |
| `ctx.config` for credentials | Agent never hardcodes secrets |
| Zod validation at load time | Agent gets immediate error feedback |
| Field descriptions | Agent understands non-English/abbreviated field names |
| Clear error hierarchy | Agent knows which exceptions to throw |
| Mock connectors as examples | Agent can read working examples before writing new ones |
| `getStreams()` pattern | Agent declares capabilities declaratively, writes fetch logic imperatively |

## The Validation Test: Agent Builds an Entire Integration

The ultimate proof that the architecture is agent-friendly: an agent should be able to build a complete integration from scratch — two connectors, discovery, and mapping — with no human code.

### The Scenario

Give an agent this prompt:

> "Here is the API documentation for System X and System Y. Build connectors for both, run discovery to match existing records, and create a mapping between them."

### What the Agent Does

**Step 1: Build both connectors**

The agent reads the SDK interfaces (`@opensync/sdk`), reads the API docs, and generates two connector files. It uses `opensync create-connector` as a starting point, then fills in `getStreams()`, `upsert()`, and `prepareRequest()`.

It validates by loading the connectors (`opensync add-connector`) and running a test fetch.

**Step 2: Run discovery**

The agent runs `opensync match system-x system-y --entity contact` and reads the match report. It sees:
- 600 exact matches on email
- 12 partial matches (similar names)
- 200 unique in X, 50 unique in Y

It decides to link the exact matches and flag partials for review.

**Step 3: Analyze data and design mapping**

The agent looks at sample records from both sides. It sees that System X has `firstName` + `lastName` while System Y has `fullName`. It sees that phone formats differ. It proposes:

```typescript
const mapping: EntityMapping = {
  sourceEntity: 'contact',
  targetEntity: 'customer',
  fields: [
    { sourceField: 'firstName', targetField: 'fullName',
      transform: (d) => ({ ...d, fullName: `${d.firstName} ${d.lastName}` }) },
    { sourceField: 'email', targetField: 'emailAddress',
      transform: (d) => ({ ...d, emailAddress: d.email?.toLowerCase() }) },
    { sourceField: 'phone', targetField: 'phoneNumber',
      transform: (d) => ({ ...d, phoneNumber: normalizePhone(d.phone) }) },
  ]
};
```

It also suggests conflict rules: "System X updates contacts more frequently — suggest it as master for contact fields. System Y has authoritative financial data — suggest it as master for invoice fields."

**Step 4: Test the sync**

The agent runs `opensync sync` and verifies data flows correctly in both directions. It checks for echo loops and confirms the circuit breaker isn't tripping.

### Why This Works

Every design choice enables this workflow:

- TypeScript interfaces give the agent type-checked guardrails
- `ctx.http` means the agent doesn't write auth/retry/logging code
- `getStreams()` tells the agent exactly what to implement
- The match report gives the agent structured data to reason about
- Mock connectors serve as working examples the agent can study first
- The CLI gives the agent concrete commands to validate each step

### If This Test Fails

If an agent can't complete this flow, something in the SDK or engine is too complex or poorly documented. This scenario is the benchmark for developer experience — if an agent can't do it, a human will struggle too.

## Agent-Assisted Onboarding

During the discovery/matching phase, an agent can assist with uncertain matches:

- **Field mapping suggestions**: "I see `fnavn` in Fiken and `firstName` in HubSpot. These are likely the same field."
- **Duplicate resolution**: "These two records have the same email but different names. Likely the same person — 92% confidence."
- **Conflict rule suggestions**: "Based on the data, HubSpot seems to be the source of truth for contact info and Fiken for financial data. Suggested master rules: ..."

This is not built into the engine as AI logic — it's a pattern that agents naturally follow when they have access to the match report and raw data.

## Agent-Assisted Monitoring (Future)

Agents can act as intelligent monitors over the running engine:

- **Pattern detection**: "Every Tuesday at 02:00, 500 addresses change in Salesforce. This looks like a scheduled batch job from another system."
- **Anomaly alerts**: "HubSpot is sending 10x more webhooks than usual. This might be a bulk import or an API issue."
- **Auto-remediation**: "The Fiken connector is failing because the access token expired. I'll trigger a token refresh."
- **Proactive suggestions**: "Your phone number mapping causes a loop between HubSpot and Fiken because they format numbers differently. I suggest adding a normalizer."

This requires the engine to expose its state (shadow state, request journal, circuit breaker status) in a way agents can query — which it already does via SQLite.
