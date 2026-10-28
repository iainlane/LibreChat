const { createPromptServices } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { grantPermission, getEffectivePermissions } = require('~/server/services/PermissionService');
const db = require('~/models');

module.exports = createPromptServices({
  db,
  grantPermission,
  getEffectivePermissions,
  getAppConfig,
});
