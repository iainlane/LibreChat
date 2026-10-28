import { getConfigPromptIds } from '@librechat/data-schemas';
import type { PromptLibraryConfig } from 'librechat-data-provider';
import type {
  ConfigPromptCatalogReader,
  PromptGroupRecord,
  PromptSourceAdapter,
  PromptStore,
} from './types';
import { createNativePromptAdapter } from './native';

export function createConfigPromptCatalogReader(
  getAppConfig: () => Promise<{ prompts?: PromptLibraryConfig }>,
): ConfigPromptCatalogReader {
  return async () => {
    const config = await getAppConfig();
    const entries = new Map(
      (config?.prompts?.library ?? []).map((entry) => {
        const ids = getConfigPromptIds(entry);
        return [ids.groupId, { ...entry, ...ids }];
      }),
    );

    return {
      projectGroup(group) {
        if (group.source !== 'config') {
          return group;
        }
        const entry = entries.get(group._id);
        if (entry === undefined) {
          return null;
        }
        return {
          ...group,
          name: entry.name,
          oneliner: entry.description ?? '',
          category: '',
          productionId: entry.promptId,
          productionPrompt: {
            _id: entry.promptId,
            groupId: entry.groupId,
            author: group.author,
            prompt: entry.prompt,
            type: 'text',
          },
        };
      },
      matchingGroupIds({ name, category }) {
        if (category != null && category !== '') {
          return [];
        }
        const query = name?.toLowerCase();
        return [...entries.values()]
          .filter((entry) => !query || entry.name.toLowerCase().includes(query))
          .map((entry) => entry.groupId);
      },
    };
  };
}

export function createConfigPromptAdapter(
  store: Pick<PromptStore, 'getPrompt'>,
  readCatalog: ConfigPromptCatalogReader,
): PromptSourceAdapter {
  const adapter = createNativePromptAdapter(store, 'config');
  return {
    async resolvePrompt({ group, ...input }) {
      const catalog = await readCatalog();
      const projected: PromptGroupRecord | null = catalog.projectGroup(group);
      if (projected === null) {
        return {
          ok: false,
          error: {
            type: 'unavailable_selection',
            reason: input.selection.type === 'production' ? 'production' : 'revision',
          },
        };
      }
      return adapter.resolvePrompt({ ...input, group: projected });
    },
  };
}
