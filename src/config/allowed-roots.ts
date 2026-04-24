import { resolve } from 'path';
import { getSettingsSync } from './index';

// Get allowed roots from settings
export function getAllowedRoots(): string[] {
  try {
    const settings = getSettingsSync();
    return settings.security.allowedRoots;
  } catch {
    // Fallback to default if settings not loaded yet (for backward compatibility)
    return [process.cwd()];
  }
}

export let allowedRoots = getAllowedRoots();

export function setAllowedRoots(newRoots: string[]): void {
  allowedRoots = newRoots.map(root => resolve(root));
}
