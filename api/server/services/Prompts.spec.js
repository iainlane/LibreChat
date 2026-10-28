const mockDb = { marker: 'db' };
const mockGrantPermission = jest.fn();
const mockGetAppConfig = jest.fn();
const mockPromptServiceInstance = { promptService: { marker: 'promptService' } };
const mockGetEffectivePermissions = jest.fn();
const mockCreatePromptServices = jest.fn(() => mockPromptServiceInstance);

jest.mock('@librechat/api', () => ({
  createPromptServices: mockCreatePromptServices,
}));

jest.mock('~/models', () => mockDb);

jest.mock('~/server/services/PermissionService', () => ({
  grantPermission: mockGrantPermission,
  getEffectivePermissions: mockGetEffectivePermissions,
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: mockGetAppConfig,
}));

describe('Prompts', () => {
  it('builds the process prompt service once with the shared db, grantPermission and getAppConfig', () => {
    const { promptService } = require('./Prompts');

    expect(mockCreatePromptServices).toHaveBeenCalledTimes(1);
    expect(mockCreatePromptServices).toHaveBeenCalledWith({
      db: mockDb,
      grantPermission: mockGrantPermission,
      getEffectivePermissions: mockGetEffectivePermissions,
      getAppConfig: mockGetAppConfig,
    });
    expect(promptService).toBe(mockPromptServiceInstance.promptService);
  });
});
