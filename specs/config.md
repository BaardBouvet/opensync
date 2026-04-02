# Configuration

All engine configuration lives in YAML files validated by Zod schemas at load time.

## Config File Structure

```yaml
# opensync.yaml — main config file

connectors:
  - name: mock-crm
    instance: crm-prod
    environment: production
    config:
      baseUrl: "http://localhost:4000"

  - name: mock-erp
    instance: erp-prod
    environment: production
    config:
      baseUrl: "http://localhost:4001"

channels:
  - name: "Contact Sync"
    entity_type: contact
    members:
      - instance: crm-prod
        role:
          master_fields: [email, phone]
      - instance: erp-prod
        role:
          master_fields: [organizationName]
    conflict_resolution:
      default: lww
    circuit_breaker:
      volume_threshold: 100
      error_rate_threshold: 0.3
      loop_detection:
        max_oscillations: 5
        window_minutes: 10
      cooldown_minutes: 30
    scheduling:
      poll_interval_seconds: 300    # 5 minutes
      full_sync_cron: "0 2 * * *"  # daily at 02:00

mappings:
  - source_entity: contact
    target_entity: customer
    fields:
      - source: firstName
        target: fullName
      - source: email
        target: emailAddress
      - source: phone
        target: phoneNumber

triggers:
  - name: "Deal Won Email"
    event: record.updated
    entity: deal
    condition:
      field: status
      operator: changed_to
      value: won
    action: send-email
    payload:
      to: "{{email}}"
      subject: "Deal closed: {{dealName}}"
```

## Mapping Configuration

### Simple field rename
```yaml
- source: email
  target: emailAddress
```

### With transform (reference to a TS function)
```yaml
- source: firstName
  target: fullName
  transform: "transforms/concat-name"   # path to a TS module exporting a TransformFn
```

### Match rules (for discovery/onboarding)
```yaml
matching:
  rules:
    - source_field: email
      target_field: emailAddress
      strategy: exact
    - source_field: firstName
      target_field: fullName
      strategy: fuzzy
      threshold: 0.85
```

## Connector Instance Config

Per-instance settings stored in `connector_instances.config` (JSONB). Structure depends on the connector:

```yaml
# OAuth-based connector
config:
  baseUrl: "https://api.hubspot.com"
  clientId: "abc123"
  clientSecret: "secret"    # encrypted at rest
  scopes: ["contacts", "deals"]

# API key connector
config:
  baseUrl: "https://api.fiken.no/v2"
  apiKey: "fiken_api_key_here"
  foretakId: "123456789"

# Database connector
config:
  host: "db.example.com"
  port: 5432
  database: "erp_prod"
  user: "readonly"
  password: "secret"
```

## Environment Resolution

If a connector's metadata includes `environments`:
```typescript
metadata: {
  environments: {
    production: "https://api.fiken.no/v2",
    test: "https://api.fiken.no/sandbox"
  }
}
```

And the instance config specifies `environment: "test"`, the engine automatically sets `config.baseUrl` to the sandbox URL.

## Validation

All config is validated at load time using Zod schemas:

```typescript
// config-schema.ts
const ConnectorInstanceSchema = z.object({
  name: z.string(),
  instance: z.string(),
  environment: z.string().optional(),
  config: z.record(z.unknown()),
});

const ChannelSchema = z.object({
  name: z.string(),
  entity_type: z.string(),
  members: z.array(ChannelMemberSchema),
  conflict_resolution: ConflictResolutionSchema.optional(),
  circuit_breaker: CircuitBreakerConfigSchema.optional(),
  scheduling: SchedulingSchema.optional(),
});

// ... etc
```

Invalid config fails fast with clear error messages before any sync runs.
