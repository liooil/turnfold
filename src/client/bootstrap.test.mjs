import {describe, expect, test} from "bun:test";
import {readFileSync} from "node:fs";

const source = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
const initializeStart = source.indexOf("async function initialize()");
const connectStart = source.indexOf("async function connectBackend(");
const initializeSource = source.slice(initializeStart, connectStart);
const agentSource = readFileSync(new URL("./providers/provider-agent-controller.ts", import.meta.url), "utf8");
const agentInitializeStart = agentSource.indexOf("function initialize()");
const agentConnectStart = agentSource.indexOf("async function connect(");
const agentInitializeSource = agentSource.slice(agentInitializeStart, agentConnectStart);

describe("browser-local startup", () => {
  test("keeps Backend discovery and synchronization behind explicit connect", () => {
    expect(initializeStart).toBeGreaterThan(-1);
    expect(connectStart).toBeGreaterThan(initializeStart);
    expect(initializeSource).not.toContain("fetchBackendConfig(");
    expect(initializeSource).not.toContain("synchronizeConversationRepository(");
    expect(initializeSource).not.toMatch(/\bfetch\s*\(/);
    expect(source.slice(connectStart)).toContain("fetchBackendConfig(backendUrl");
  });

  test("keeps Provider Agent discovery behind its own explicit connect", () => {
    expect(agentInitializeStart).toBeGreaterThan(-1);
    expect(agentConnectStart).toBeGreaterThan(agentInitializeStart);
    expect(agentInitializeSource).not.toContain("fetchProviderAgentInfo(");
    expect(agentInitializeSource).not.toMatch(/\bfetch\s*\(/);
    expect(agentSource.slice(agentConnectStart)).toContain("fetchProviderAgentInfo(agentUrl");
  });
});
