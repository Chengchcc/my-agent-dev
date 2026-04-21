import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { useCallback, useRef, useState, useEffect } from "react";

const HISTORY_FILENAME = "history.txt";
const MAX_HISTORY_LINES = 100;

function getHistoryFilePath(): string {
  return path.join(os.homedir(), ".my-agent", HISTORY_FILENAME);
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

  // Load history on mount
  useEffect(() => {
    loadHistoryFromDisk().then(history => {
      historyRef.current = history;
    });
  }, []);

  const isBrowsing = historyIndex !== null;

  const browseUp = useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;

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
      return "";
    }

    setHistoryIndex(nextIndex);
    return history[nextIndex] ?? null;
  }, [historyIndex]);

  const exitBrowsing = useCallback(() => {
    if (historyIndex !== null) {
      setHistoryIndex(null);
    }
  }, [historyIndex]);

  const saveEntry = useCallback((text: string) => {
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
    setHistoryIndex(null);
  }, []);

  return { isBrowsing, browseUp, browseDown, exitBrowsing, saveEntry };
}
