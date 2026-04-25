import { loadSettings } from './loader';
import type { Settings } from './types';

// Eagerly load settings on module import
let cachedSettings: Settings | null = null;

/**
 * Get the current settings, loading if not cached
 */
export async function getSettings(): Promise<Settings> {
  if (!cachedSettings) {
    cachedSettings = await loadSettings();
  }
  return cachedSettings;
}

/**
 * Get the cached settings synchronously (must be loaded first)
 * Use this after initial loading is complete.
 */
export function getSettingsSync(): Settings {
  if (!cachedSettings) {
    throw new Error('Settings not loaded yet. Call getSettings() first.');
  }
  return cachedSettings;
}

/**
 * Clear cache - mostly for testing
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}

// Lazy initialization - most code can import this directly
// But need to ensure it's loaded before use
export const settings = new Proxy({} as Settings, {
  get(_target, prop) {
    if (!cachedSettings) {
      throw new Error(
        'Settings not loaded yet. Await getSettings() at application startup before accessing settings.'
      );
    }
    return Reflect.get(cachedSettings, prop);
  },
  has(_target, prop) {
    if (!cachedSettings) {
      return false;
    }
    return Reflect.has(cachedSettings, prop);
  },
  ownKeys(_target) {
    if (!cachedSettings) {
      return [];
    }
    return Reflect.ownKeys(cachedSettings);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (!cachedSettings) {
      return undefined;
    }
    return Reflect.getOwnPropertyDescriptor(cachedSettings, prop);
  },
  set(_target, prop, value) {
    if (!cachedSettings) {
      throw new Error(
        'Settings not loaded yet. Await getSettings() at application startup before accessing settings.'
      );
    }
    return Reflect.set(cachedSettings, prop, value);
  },
});

// Re-export types
export type { Settings } from './types';
export { defaultSettings } from './defaults';
export * from './types';
