/**
 * Process entrypoint for MockErpServer.
 *
 * Configuration via environment variables:
 *   MOCK_ERP_PORT          — listening port (default: 4002)
 *   MOCK_ERP_CLIENT_ID     — OAuth2 client ID (default: opensync-test)
 *   MOCK_ERP_CLIENT_SECRET — OAuth2 client secret (default: secret)
 *   MOCK_ERP_HMAC_SECRET   — HMAC signing key (default: hmac-secret-key)
 */
import {
  MockErpServer,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_HMAC_SECRET,
} from "./server.js";

const port = parseInt(process.env["MOCK_ERP_PORT"] ?? "4002", 10);
const clientId = process.env["MOCK_ERP_CLIENT_ID"] ?? DEFAULT_CLIENT_ID;
const clientSecret = process.env["MOCK_ERP_CLIENT_SECRET"] ?? DEFAULT_CLIENT_SECRET;
const hmacSecret = process.env["MOCK_ERP_HMAC_SECRET"] ?? DEFAULT_HMAC_SECRET;

const server = new MockErpServer({ clientId, clientSecret, hmacSecret });
server.start(port);

console.log(`MockErpServer listening on http://localhost:${server.port}`);
