# mock-crm-erp

Syncs contacts (CRM) with employees (ERP) across a `people` channel. Demonstrates the engine
against real HTTP connectors with authentication — the mock servers behave like real SaaS APIs.

```
bun run demo mock-crm-erp
```

## Prerequisites — start the servers

Open two terminal tabs and run one server in each:

```sh
# Terminal 1 — Mock CRM (port 4001)
MOCK_CRM_API_KEY=test-api-key-secret bun run --cwd dev/servers/mock-crm start

# Terminal 2 — Mock ERP (port 4002)
bun run --cwd dev/servers/mock-erp start
```

The CRM server accepts `Bearer test-api-key-secret` as the API key. The ERP uses OAuth2
client credentials (`clientId: opensync-test`, `clientSecret: secret`).

## Run the demo

In a third terminal:

```sh
MOCK_CRM_API_KEY=test-api-key-secret bun run demo/run.ts -d mock-crm-erp
```

The runner reads `demo/examples/mock-crm-erp/opensync.json`, loads the CRM and ERP connectors,
and begins polling both systems every 2 s.

## Notes

No `seed/` directory — the servers manage their own in-memory fixture data. Delete
`demo/data/mock-crm-erp/` together with a server restart for a fully clean slate.
