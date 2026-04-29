import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { useCallback, useRef, useState, useEffect } from "react";
import { getSettingsSync } from "../../../config";
import { defaultSettings } from "../../../config/defaults";

function getSettings() {
  try {
    return getSettingsSync();
  } catch {
    return defaultSettings;
  }
}

const settings = getSettings();

const MAX_HISTORY_LINES = settings.tui.history.maxLines;

function getHistoryFilePath(): string {
  return getSettings().tui.history.filePath;
}

async function loadHistoryFromDisk(): Promise<string[]> {
  const filePath = getHistoryFilePath();
  try {
    const content = await readFile(filePath, 'utf8');
    const trimmedContent = content.trim();
    if (!trimmedContent) return [];
    return trimmedContent.split('\n');
  } catch {
    return [];
  }
}

async function saveHistoryToDisk(lines: string[]): Promise<void> {
  const trimmed = lines.slice(-MAX_HISTORY_LINES);
  const filePath = getHistoryFilePath();
  const dir = path.dirname(filePath);

  try {
    // Ensure directory exists
    const dirExists = existsSync(dir);
    if (!dirExists) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, trimmed.join('\n') + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to save history:', err);
  }
}

export function useInputHistory() {
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyRef = useRef<string[]>([]);
  const loadedRef = useRef(false);
  const pendingSavesRef = useRef<string[]>([]);

  // Load history on mount
  useEffect(() => {
    void loadHistoryFromDisk().then(history => {
      historyRef.current = history;
      loadedRef.current = true;
      // Flush any saves that queued during the loading window
      for (const text of pendingSavesRef.current) {
        doSave(text);
      }
      pendingSavesRef.current = [];
    });
  }, []);

  const isBrowsing = historyIndex !== null;

  const preBrowseTextRef = useRef<string>('');

  const beginBrowsing = useCallback((currentText: string) => {
    preBrowseTextRef.current = currentText;
  }, []);

  const browseUp = useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;

    if (historyIndex === null) {
      preBrowseTextRef.current = ''; // caller should use beginBrowsing first
    }
    const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
    setHistoryIndex(nextIndex);
    return history[nextIndex] ?? null;
  }, [historyIndex]);

  const browseDown = useCallback((): string | null => {
    if (historyIndex === null) return null;

    const history = historyRef.current;
    const nextIndex = historyIndex + 1;

    if (nextIndex >= history.length) {
      setHistoryIndex(null);
      return preBrowseTextRef.current;
    }

    setHistoryIndex(nextIndex);
    return history[nextIndex] ?? null;
  }, [historyIndex]);

  const exitBrowsing = useCallback((): string | null => {
    if (historyIndex !== null) {
      setHistoryIndex(null);
      return preBrowseTextRef.current;
    }
    return null;
  }, [historyIndex]);

  const doSave = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const history = historyRef.current;
    if (history.length > 0 && history[history.length - 1] === trimmed) return;

    history.push(trimmed);
    if (history.length > MAX_HISTORY_LINES) {
      historyRef.current = history.slice(-MAX_HISTORY_LINES);
    }
    saveHistoryToDisk(historyRef.current).catch(err => {
      console.error('Failed to save history:', err);
    });
  }, []);

  const saveEntry = useCallback((text: string) => {
    if (!loadedRef.current) {
      // Queue saves until initial load completes to avoid race with loadHistoryFromDisk
      pendingSavesRef.current.push(text);
      return;
    }
    doSave(text);
    setHistoryIndex(null);
  }, [doSave]);

  return { isBrowsing, beginBrowsing, browseUp, browseDown, exitBrowsing, saveEntry };
}
