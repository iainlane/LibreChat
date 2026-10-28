import {
  AccessRoleIds,
  PrincipalType,
  ResourceType,
  PermissionTypes,
  Permissions,
} from 'librechat-data-provider';
import type { EnsurePromptCatalog, ConfigPromptCatalogDeps } from './catalog';
import type { ChatPromptService, ChatPromptServiceDeps } from './defaults';
import type { PromptService, PromptServiceDependencies } from './service';
import { createConfigPromptCatalog } from './catalog';
import { createChatPromptService } from './defaults';
import { createPromptService } from './service';
import { CONSTANTS } from '~/mcp/enum';

interface PromptServicesDeps extends Omit<PromptServiceDependencies, 'db'> {
  db: PromptServiceDependencies['db'] & {
    syncConfigPrompts: ConfigPromptCatalogDeps['syncConfigPrompts'];
    invalidatePromptGroupAccessContext: ConfigPromptCatalogDeps['invalidateAccess'];
    getRoleByName(role: string): Promise<{
      permissions?: { [PermissionTypes.PROMPTS]?: { [Permissions.USE]?: boolean } };
    } | null>;
  };
  getEffectivePermissions: ChatPromptServiceDeps['getEffectivePermissions'];
}

export function createPromptServices(deps: PromptServicesDeps): {
  promptService: PromptService;
  ensurePromptCatalog: EnsurePromptCatalog;
  chatPromptService: ChatPromptService;
} {
  const promptService = createPromptService(deps);
  const ensurePromptCatalog = createConfigPromptCatalog({
    syncConfigPrompts: deps.db.syncConfigPrompts,
    grantPublicViewer: (groupId) =>
      deps.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: CONSTANTS.SYSTEM_USER_ID,
      }),
    invalidateAccess: deps.db.invalidatePromptGroupAccessContext,
  });
  const chatPromptService = createChatPromptService({
    promptService,
    ensureCatalog: ensurePromptCatalog,
    getEffectivePermissions: deps.getEffectivePermissions,
    async canUsePrompts(user) {
      if (!user.role) {
        return false;
      }
      const role = await deps.db.getRoleByName(user.role);
      return role?.permissions?.[PermissionTypes.PROMPTS]?.[Permissions.USE] === true;
    },
  });
  return { promptService, ensurePromptCatalog, chatPromptService };
}
