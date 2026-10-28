import { createHash } from 'crypto';
import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { PromptLibraryConfig } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types';

export interface ConfigPromptCatalogDeps {
  syncConfigPrompts(
    entries: PromptLibraryConfig['library'],
  ): Promise<{ id: string; groupId: string }[]>;
  grantPublicViewer(groupId: string): Promise<unknown>;
  invalidateAccess(): Promise<void>;
}

export type EnsurePromptCatalog = (
  config?: PromptLibraryConfig,
) => Promise<ReadonlyMap<string, string>>;

export function createConfigPromptCatalog(deps: ConfigPromptCatalogDeps): EnsurePromptCatalog {
  const synchronized = new Map<string, { digest: string; groups: ReadonlyMap<string, string> }>();
  const pending = new Map<string, { digest: string; task: Promise<ReadonlyMap<string, string>> }>();

  return async (config) => {
    const tenantId = getTenantId() ?? '';
    if (tenantId === SYSTEM_TENANT_ID) {
      throw new Error('Configuration prompt synchronization requires a tenant scope.');
    }
    const entries = config?.library ?? [];
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    const current = synchronized.get(tenantId);
    if (current?.digest === digest) {
      return current.groups;
    }
    while (pending.has(tenantId)) {
      const active = pending.get(tenantId);
      if (active?.digest === digest) {
        return active.task;
      }
      await active?.task;
      const completed = synchronized.get(tenantId);
      if (completed?.digest === digest) {
        return completed.groups;
      }
    }
    const task = (async () => {
      const groups = await deps.syncConfigPrompts(entries);
      await Promise.all(groups.map(({ groupId }) => deps.grantPublicViewer(groupId)));
      await deps.invalidateAccess();
      const catalog = new Map(groups.map(({ id, groupId }) => [id, groupId]));
      synchronized.set(tenantId, { digest, groups: catalog });
      return catalog;
    })();
    pending.set(tenantId, { digest, task });
    try {
      return await task;
    } finally {
      if (pending.get(tenantId)?.task === task) {
        pending.delete(tenantId);
      }
    }
  };
}

export function createPromptCatalogMiddleware(ensureCatalog: EnsurePromptCatalog) {
  return async (req: ServerRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await ensureCatalog(req.config?.prompts);
      next();
    } catch (error) {
      next(error);
    }
  };
}
