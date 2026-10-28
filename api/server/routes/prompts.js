const express = require('express');
const {
  generateCheckAccess,
  createPromptHandlers,
  createPromptCatalogMiddleware,
  createChatPromptPreferencesHandlers,
  invalidateLinkedPrompt,
} = require('@librechat/api');
const {
  CacheKeys,
  Permissions,
  PermissionBits,
  PermissionTypes,
} = require('librechat-data-provider');
const {
  canAccessPromptGroupResource,
  canAccessPromptViaGroup,
  promptUsageLimiter,
  promptResolveLimiter,
  requireJwtAuth,
  configMiddleware,
} = require('~/server/middleware');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const {
  promptService,
  ensurePromptCatalog,
  chatPromptService,
} = require('~/server/services/Prompts');
const { getLogStores } = require('~/cache');
const db = require('~/models');

const { getRoleByName } = db;
const router = express.Router();

const linkedInstructionsCache = getLogStores(CacheKeys.AGENT_LINKED_INSTRUCTIONS);

const handlers = createPromptHandlers({
  service: promptService,
  getPromptGroupAccessContext: db.getPromptGroupAccessContext,
  getEffectivePermissions,
  invalidateLinkedPrompt: (groupId, promptIds) =>
    invalidateLinkedPrompt(linkedInstructionsCache, groupId, promptIds),
});

const checkPromptAccess = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkPromptCreate = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

router.use(requireJwtAuth);
router.use(configMiddleware);
router.use(createPromptCatalogMiddleware(ensurePromptCatalog));
const preferenceHandlers = createChatPromptPreferencesHandlers({
  service: chatPromptService,
  updateUserChatPrompt: db.updateUserChatPrompt,
});
router.get('/default', preferenceHandlers.get);
router.put('/default', preferenceHandlers.put);
router.use(checkPromptAccess);

router.get(
  '/groups/:groupId',
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.getPromptGroup,
);
router.get(
  '/groups/:groupId/resolve',
  promptResolveLimiter,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.resolvePrompt,
);
router.get('/all', handlers.listAllPromptGroups);
router.get('/groups', handlers.listPromptGroups);

router.post('/', checkPromptCreate, handlers.createPromptGroup);
router.post(
  '/groups/:groupId/prompts',
  checkPromptAccess,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.savePrompt,
);
router.post(
  '/groups/:groupId/use',
  promptUsageLimiter,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.recordPromptUsage,
);

router.patch(
  '/groups/:groupId',
  checkPromptCreate,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.updatePromptGroup,
);
router.patch(
  '/:promptId/tags/production',
  checkPromptCreate,
  canAccessPromptViaGroup({ requiredPermission: PermissionBits.EDIT, resourceIdParam: 'promptId' }),
  handlers.makePromptProduction,
);

router.get(
  '/:promptId',
  canAccessPromptViaGroup({ requiredPermission: PermissionBits.VIEW, resourceIdParam: 'promptId' }),
  handlers.getPrompt,
);
router.get('/', handlers.getPrompts);

router.delete(
  '/:promptId',
  checkPromptCreate,
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'promptId',
  }),
  handlers.deletePrompt,
);
router.delete(
  '/groups/:groupId',
  checkPromptCreate,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.DELETE }),
  handlers.deletePromptGroup,
);

module.exports = router;
