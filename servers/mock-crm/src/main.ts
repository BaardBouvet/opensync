/**
 * Process entrypoint for MockCrmServer.
 *
 * Configuration via environment variables:
 *   MOCK_CRM_PORT    — listening port (default: 4001)
 *   MOCK_CRM_API_KEY — bearer token to accept (default: test-api-key-secret)
 */
import { MockCrmServer, DEFAULT_API_KEY } from "./server.js";

const port = parseInt(process.env["MOCK_CRM_PORT"] ?? "4001", 10);
const apiKey = process.env["MOCK_CRM_API_KEY"] ?? DEFAULT_API_KEY;

const server = new MockCrmServer(apiKey);
server.start(port);

console.log(`MockCrmServer listening on http://localhost:${server.port}`);
