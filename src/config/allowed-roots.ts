import { resolve } from 'path';
import { getSettingsSync } from './index';

// Get allowed roots from settings
function getAllowedRoots(): string[] {
  try {
    const settings = getSettingsSync();
    return settings.security.allowedRoots.map(root => resolve(root));
  } catch {
    // Fallback to default if settings not loaded yet
    return [resolve(process.cwd())];
  }
}

// Immutable allowed roots - initialized once at module load
export const allowedRoots = getAllowedRoots();
