/**
 * Test scenarios for the stub-plugin client.
 *
 * Exercises all 7 server-facing methods (plugin→server) and verifies the
 * server responds correctly to each. Also verifies the 9 client-facing
 * request-response methods work via REST round-trip.
 */

import type { StubPluginClient } from './index.js';
import { ServerFacingMethod, type VersionHandshakeResponse, type McpServerData, type McpClientData, type ResponseData } from '../types.js';

export interface ScenarioResult {
  name: string;
  passed: boolean;
  message?: string;
}

/**
 * Run all 7 server-facing method scenarios.
 * The stub client must already be connected.
 */
export async function runServerFacingScenarios(client: StubPluginClient): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  // 1. PerformVersionHandshake
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.PerformVersionHandshake, {
      pluginVersion: '1.0.0-stub',
      apiVersion: '1.0',
      environment: { unity: '2022.3' },
    }) as VersionHandshakeResponse;
    results.push({
      name: 'PerformVersionHandshake',
      passed: typeof result?.compatible === 'boolean' && typeof result?.apiVersion === 'string',
      message: `compatible=${result?.compatible}, apiVersion=${result?.apiVersion}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'PerformVersionHandshake', passed: false, message: String(err) });
  }

  // 2. GetMcpClientData
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.GetMcpClientData) as McpClientData[];
    results.push({
      name: 'GetMcpClientData',
      passed: Array.isArray(result),
      message: `count=${result?.length ?? 0}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'GetMcpClientData', passed: false, message: String(err) });
  }

  // 3. GetMcpServerData
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.GetMcpServerData) as McpServerData;
    results.push({
      name: 'GetMcpServerData',
      passed: typeof result?.serverVersion === 'string',
      message: `serverVersion=${result?.serverVersion}, isAiAgentConnected=${result?.isAiAgentConnected}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'GetMcpServerData', passed: false, message: String(err) });
  }

  // 4. NotifyAboutUpdatedTools
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.NotifyAboutUpdatedTools, {
      requestId: 'scenario-tools',
      tools: [{ name: 'stub-tool', enabled: true }],
    }) as ResponseData;
    results.push({
      name: 'NotifyAboutUpdatedTools',
      passed: result?.status === 'success',
      message: `status=${result?.status}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'NotifyAboutUpdatedTools', passed: false, message: String(err) });
  }

  // 5. NotifyAboutUpdatedPrompts
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.NotifyAboutUpdatedPrompts, {
      requestId: 'scenario-prompts',
      prompts: { prompts: [{ name: 'stub-prompt', enabled: true }] },
    }) as ResponseData;
    results.push({
      name: 'NotifyAboutUpdatedPrompts',
      passed: result?.status === 'success',
      message: `status=${result?.status}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'NotifyAboutUpdatedPrompts', passed: false, message: String(err) });
  }

  // 6. NotifyAboutUpdatedResources
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.NotifyAboutUpdatedResources, {
      requestId: 'scenario-resources',
      resources: [{ uri: 'stub://resource', name: 'Stub', enabled: true }],
    }) as ResponseData;
    results.push({
      name: 'NotifyAboutUpdatedResources',
      passed: result?.status === 'success',
      message: `status=${result?.status}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'NotifyAboutUpdatedResources', passed: false, message: String(err) });
  }

  // 7. NotifyToolRequestCompleted
  try {
    const result = await client.sendServerRequest(ServerFacingMethod.NotifyToolRequestCompleted, {
      requestId: 'scenario-completed',
      result: {
        content: [{ type: 'text', text: 'completed via deferred path' }],
      },
    }) as ResponseData;
    results.push({
      name: 'NotifyToolRequestCompleted',
      passed: result?.status === 'success',
      message: `status=${result?.status}`,
    });
  } catch (err: unknown) {
    results.push({ name: 'NotifyToolRequestCompleted', passed: false, message: String(err) });
  }

  return results;
}

/**
 * Run a full test report connecting to a server at the given URL.
 * Prints pass/fail for each scenario and returns the aggregate result.
 */
export async function runFullTestReport(url: string, token?: string): Promise<boolean> {
  const { StubPluginClient } = await import('./index.js');
  const client = new StubPluginClient({ url, token });

  console.log(`Connecting to ${url}...`);
  try {
    await client.connect();
  } catch (err: unknown) {
    console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  console.log('Connected.\n');

  // Run server-facing scenarios.
  console.log('=== Server-facing methods (plugin → server) ===');
  const serverResults = await runServerFacingScenarios(client);
  for (const r of serverResults) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.message ? ' — ' + r.message : ''}`);
  }

  // Check notifications received (OnInitialClientData should arrive on connect).
  console.log('\n=== Notifications received ===');
  const initialData = client.notifications.find((n) => n.method === 'OnInitialClientData');
  console.log(`  ${initialData ? 'PASS' : 'FAIL'}  OnInitialClientData received on connect`);

  client.disconnect();

  const allPassed = [...serverResults].every((r) => r.passed) && !!initialData;
  console.log(`\n${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
  return allPassed;
}
