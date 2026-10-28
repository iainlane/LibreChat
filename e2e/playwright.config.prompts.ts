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
fs.writeFileSync(
  configPath,
  yaml.dump({
    ...baseConfig,
    mcpServers: {},
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
      LIBRECHAT_TEST_RUN_HOOK: path.resolve(__dirname, 'prompts/model.cjs'),
    },
  })),
});
