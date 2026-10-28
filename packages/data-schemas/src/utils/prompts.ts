import { createHash } from 'crypto';
import { getTenantId } from '~/config/tenantContext';

/** Derives tenant-scoped identifiers for a managed group and its text revision. */
export function getConfigPromptIds(entry: { id: string; prompt: string }): {
  groupId: string;
  promptId: string;
} {
  const tenant = getTenantId() ?? '';
  const idFor = (value: string): string =>
    createHash('sha256')
      .update(JSON.stringify(['config-prompt', tenant, value]))
      .digest('hex')
      .slice(0, 24);

  return {
    groupId: idFor(entry.id),
    promptId: idFor(JSON.stringify([entry.id, entry.prompt])),
  };
}
