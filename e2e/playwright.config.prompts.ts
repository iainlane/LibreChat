import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

const generated = path.resolve(__dirname, '.generated');
const configPath = path.join(generated, 'librechat.prompts.yaml');
const original = fs.readFileSync(path.join(generated, 'librechat.e2e.yaml'), 'utf8');
const baseConfig = yaml.load(original);
if (baseConfig === null || typeof baseConfig !== 'object' || Array.isArray(baseConfig)) {
  throw new Error('The mock configuration must be a YAML object.');
}
const baseMCPServers = 'mcpServers' in baseConfig ? baseConfig.mcpServers : undefined;
if (
  baseMCPServers === null ||
  typeof baseMCPServers !== 'object' ||
  Array.isArray(baseMCPServers)
) {
  throw new Error('The mock MCP configuration must be a YAML object.');
}
const baseMCPSettings = 'mcpSettings' in baseConfig ? baseConfig.mcpSettings : undefined;
if (
  baseMCPSettings === null ||
  typeof baseMCPSettings !== 'object' ||
  Array.isArray(baseMCPSettings)
) {
  throw new Error('The mock MCP settings must be a YAML object.');
}
const baseInterface = 'interface' in baseConfig ? baseConfig.interface : undefined;
if (baseInterface === null || typeof baseInterface !== 'object' || Array.isArray(baseInterface)) {
  throw new Error('The mock interface configuration must be a YAML object.');
}
fs.writeFileSync(
  configPath,
  yaml.dump({
    ...baseConfig,
    modelSpecs: undefined,
    interface: {
      ...baseInterface,
      defaultEnabledTools: ['execute_code', 'skills', 'file_search'],
      defaultMCPServers: ['e2e-memory', 'e2e-oauth'],
    },
    mcpSettings: { ...baseMCPSettings, authorizationMode: 'nonblocking' },
    mcpServers: Object.fromEntries(
      Object.entries(baseMCPServers).filter(([name]) => ['e2e-memory', 'e2e-oauth'].includes(name)),
    ),
    prompts: {
      library: [{ id: 'general', name: 'General assistant', prompt: 'E2E_PROMPT_DEPLOYMENT' }],
      defaultChatPrompt: 'general',
    },
  }),
);

export default defineConfig({
  ...mockConfig,
  testDir: 'prompts',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  retries: 0,
  reporter: [['line']],
  webServer: (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).map((server) => ({
    ...server,
    env: {
      ...server.env,
      CONFIG_PATH: configPath,
      E2E_USE_MEMORY_MONGO: 'true',
      CODE_SANDBOX_PREWARM: 'false',
      LIBRECHAT_TEST_RUN_HOOK: path.resolve(__dirname, 'prompts/model.cjs'),
    },
  })),
});
