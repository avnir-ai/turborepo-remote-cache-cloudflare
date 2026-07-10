import type { RuntimeEnv } from './env';

import { deleteOldCache, type DeleteOldCacheResult } from '../crons/deleteOldCache';
import { createStorageServices } from '../storage/files-storage';

export const runDeleteExpired = async (runtimeEnv: RuntimeEnv): Promise<DeleteOldCacheResult> => {
  const { files, retentionHours } = await createStorageServices(runtimeEnv);
  const result = await deleteOldCache(files, retentionHours);
  if (result.skipped > 0) {
    console.warn(
      JSON.stringify({
        message: 'Skipped cache entries without last-modified metadata',
        skipped: result.skipped,
      }),
    );
  }
  return result;
};
