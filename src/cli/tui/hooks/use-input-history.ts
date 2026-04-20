import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { useCallback, useRef, useState } from "react";

const HISTORY_FILENAME = "history.txt";
const MAX_HISTORY_LINES = 100;

function getHistoryFilePath(): string {
  return path.join(os.homedir(), ".my-agent", HISTORY_FILENAME);
}

function loadHistoryFromDisk(): string[] {
  const filePath = getHistoryFilePath();
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content.split("\n");
}

function saveHistoryToDisk(lines: string[]): void {
  const trimmed = lines.slice(-MAX_HISTORY_LINES);
  const filePath = getHistoryFilePath();
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    require("node:fs").mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, trimmed.join("\n") + "\n", "utf8");
}

export function useInputHistory() {
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyRef = useRef<string[]>(loadHistoryFromDisk());

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
    saveHistoryToDisk(historyRef.current);
    setHistoryIndex(null);
  }, []);

  return { isBrowsing, browseUp, browseDown, exitBrowsing, saveEntry };
}
