import { useInput } from "ink";
import { useEffect, useMemo, useState, useRef } from "react";
import fastGlob from "fast-glob";
import {
  buildPromptSubmission,
  filterCommands,
  getBestCompletion,
  getHighlightedCommandName,
  getSlashQuery,
  insertSlashCommand,
  type PromptSubmission,
  type SlashCommand,
} from "../command-registry";
import {
  insertTextAtCursor,
  moveCursorLeft,
  moveCursorRight,
  removeCharacterBeforeCursor,
  type InputEditorState,
} from "./use-input-editor";
import { useInputHistory } from "./use-input-history";
import { attachmentMap, createPasteMarker, createPasteMarkerRe, getFoldedDisplay, hasPasteMarkers, resolvePastePlaceholders } from "../paste-attachments";

const AT_FILE_GLOB_DEPTH = 10;
const MAX_AT_FILE_RESULTS = 15;
const AT_FILE_DEBOUNCE_MS = 120;
const PASTE_FOLD_LINE_THRESHOLD = 3;
const PASTE_FOLD_CHAR_THRESHOLD = 200;

function getAtQuery(text: string): { query: string; start: number } | null {
  const lastAt = text.lastIndexOf('@');
  if (lastAt === -1) return null;
  if (lastAt > 0 && !/\s/.test(text[lastAt - 1]!)) return null;
  const query = text.slice(lastAt + 1);
  if (query.includes(' ')) return null;
  return { query, start: lastAt };
}

const WELCOME_MESSAGES = [
  "To the moon!",
  "What do you want to build today?",
  "Hey, there!",
  "What's on your mind?",
  "Build, build, build!",
  "What's your plan today?",
  "Dream, code, repeat!",
  "Your next idea goes here...",
];


// eslint-disable-next-line max-lines-per-function
export function useCommandInput({
  commands,
  streaming,
  onSubmit,
  onAbort,
}: {
  commands: SlashCommand[];
  streaming: boolean;
  onSubmit?: (submission: PromptSubmission) => void | Promise<void>;
  onAbort?: () => void;
}) {
  const [firstMessage, setFirstMessage] = useState(true);
  const [editorState, setEditorState] = useState<InputEditorState>({ text: "", cursorOffset: 0 });
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [dismissedAtQuery, setDismissedAtQuery] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [atSelectedIndex, setAtSelectedIndex] = useState(0);
  const [pasteFolded, setPasteFolded] = useState(false);
  const pasteFoldedRef = useRef(pasteFolded);
  useEffect(() => { pasteFoldedRef.current = pasteFolded; }, [pasteFolded]);
  const [welcomeMessage] = useState(
    () => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)] ?? "What's on your mind?",
  );
  const { isBrowsing, beginBrowsing, browseUp, browseDown, exitBrowsing, saveEntry } = useInputHistory();
  const editorStateRef = useRef(editorState);
  useEffect(() => {
    editorStateRef.current = editorState;
  }, [editorState]);

  const slashQuery = getSlashQuery(editorState.text);
  const filteredCommands = useMemo(
    () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),
    [commands, slashQuery],
  );
  const pickerOpen = slashQuery !== null && dismissedQuery !== slashQuery;
  const highlightedCommandName = getHighlightedCommandName(editorState.text, commands);

  const atQuery = useMemo(() => getAtQuery(editorState.text), [editorState.text]);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!atQuery || atQuery.query.length < 2) {
      setAtFiles([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fastGlob(`**/*${atQuery.query}*`, {
        cwd: process.cwd(),
        dot: true,
        deep: AT_FILE_GLOB_DEPTH,
        suppressErrors: true,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      }).then(files => {
        if (!cancelled) setAtFiles(files.slice(0, MAX_AT_FILE_RESULTS));
      }).catch(() => {
        if (!cancelled) setAtFiles([]);
      });
    }, AT_FILE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [atQuery?.query]);
  const atFilePickerOpen = atQuery !== null && dismissedAtQuery !== atQuery.query && atFiles.length > 0;

  const hasMarkers = hasPasteMarkers(editorState.text);
  const { displayText, displayCursorOffset, pasteLineCount } = useMemo(() => {
    if (!pasteFolded || !hasMarkers) {
      return { displayText: editorState.text, displayCursorOffset: editorState.cursorOffset, pasteLineCount: 0 };
    }
    const folded = getFoldedDisplay(editorState.text, editorState.cursorOffset);
    return { displayText: folded.displayText, displayCursorOffset: folded.displayCursorOffset, pasteLineCount: folded.totalPasteLines };
  }, [pasteFolded, editorState.text, editorState.cursorOffset, hasMarkers]);

  useEffect(() => {
    setSelectedIndex((currentIndex) => {
      if (filteredCommands.length === 0) return 0;
      return Math.min(currentIndex, filteredCommands.length - 1);
    });
  }, [filteredCommands.length]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setAtSelectedIndex(0);
  }, [atQuery?.query]);

  useEffect(() => {
    setAtSelectedIndex((index) => Math.min(index, Math.max(0, atFiles.length - 1)));
  }, [atFiles.length]);

  const dismissIfChanged = (newText: string) => {
    if (getSlashQuery(newText) !== dismissedQuery) setDismissedQuery(null);
    const q = getAtQuery(newText);
    if (q?.query !== dismissedAtQuery) { setDismissedAtQuery(null); setAtSelectedIndex(0); }
  };

  const updateEditorState = (next: InputEditorState | ((prev: InputEditorState) => InputEditorState)) => {
    if (typeof next === 'function') {
      setEditorState((prevState) => {
        const newState = next(prevState);
        dismissIfChanged(newState.text);
        return newState;
      });
    } else {
      setEditorState(next);
      dismissIfChanged(next.text);
    }
  };

  const acceptSelectedCommand = () => {
    const selectedCommand = filteredCommands[selectedIndex];
    if (!selectedCommand) return;

    updateEditorState({
      text: insertSlashCommand(selectedCommand),
      cursorOffset: insertSlashCommand(selectedCommand).length,
    });
    setSelectedIndex(0);
    // Dismiss the picker after accepting
    if (slashQuery !== null) {
      setDismissedQuery(slashQuery);
    }
  };

  useInput(
    // eslint-disable-next-line complexity
    (input, key) => {
      if (key.ctrl && input === "c") {
        onAbort?.();
        return;
      }

      // During streaming, let Escape bubble to AppContent for abort
      if (key.escape && streaming) {
        return;
      }

      if (pickerOpen && key.escape) {
        setDismissedQuery(slashQuery);
        return;
      }

      if (atFilePickerOpen && key.escape) {
        setDismissedAtQuery(atQuery!.query);
        return;
      }

      if (key.escape) {
        if (isBrowsing) {
          const fallback = exitBrowsing();
          const markerRe = createPasteMarkerRe();
          let m: RegExpExecArray | null;
          while ((m = markerRe.exec(editorStateRef.current.text)) !== null) {
            attachmentMap.delete(m[1]!);
          }
          setEditorState({ text: fallback ?? '', cursorOffset: fallback?.length ?? 0 });
          setDismissedQuery(null);
          setPasteFolded(false);
          return;
        }
        if (editorStateRef.current.text.length > 0) {
          exitBrowsing();
          const markerRe = createPasteMarkerRe();
          let m: RegExpExecArray | null;
          while ((m = markerRe.exec(editorStateRef.current.text)) !== null) {
            attachmentMap.delete(m[1]!);
          }
          setEditorState({ text: '', cursorOffset: 0 });
          setDismissedQuery(null);
          setPasteFolded(false);
        } else {
          onAbort?.();
        }
        return;
      }

      if (pickerOpen && filteredCommands.length > 0 && key.upArrow) {
        setSelectedIndex((index) => (index > 0 ? index - 1 : filteredCommands.length - 1));
        return;
      }

      if (pickerOpen && filteredCommands.length > 0 && key.downArrow) {
        setSelectedIndex((index) => (index < filteredCommands.length - 1 ? index + 1 : 0));
        return;
      }

      if (atFilePickerOpen && key.upArrow) {
        setAtSelectedIndex((index) => (index > 0 ? index - 1 : atFiles.length - 1));
        return;
      }

      if (atFilePickerOpen && key.downArrow) {
        setAtSelectedIndex((index) => (index < atFiles.length - 1 ? index + 1 : 0));
        return;
      }

      if (pickerOpen && filteredCommands.length > 0 && (key.return || key.tab)) {
        acceptSelectedCommand();
        return;
      }

      // Tab completion for slash commands
      if (key.tab && editorStateRef.current.text.startsWith('/')) {
        if (!pickerOpen) {
          const completion = getBestCompletion(slashQuery ?? '', commands);
          if (completion) {
            updateEditorState({
              text: `/${completion} `,
              cursorOffset: completion.length + 2,
            });
            setDismissedQuery(slashQuery);
          } else {
            setDismissedQuery(null);
          }
        }
        return;
      }

      // Tab / Enter completion for @ file references
      if ((key.tab || key.return) && atQuery && atFiles.length > 0) {
        if (!atFilePickerOpen && key.return) {
          // Enter without open picker — don't intercept, let it submit
        } else {
          const file = atFiles[atSelectedIndex]!;
          const before = editorStateRef.current.text.slice(0, atQuery.start);
          const text = before + file + ' ';
          updateEditorState({ text, cursorOffset: text.length });
          setDismissedAtQuery(atQuery.query);
          return;
        }
      }

      if (key.return) {
        if (key.shift) {
          // Insert newline instead of submitting
          exitBrowsing();
          updateEditorState(prev => insertTextAtCursor(prev, '\n'));
          return;
        }

        // Regular enter - submit
        const resolvedText = resolvePastePlaceholders(editorStateRef.current.text);
        const markerRe = createPasteMarkerRe();
        let m: RegExpExecArray | null;
        while ((m = markerRe.exec(editorStateRef.current.text)) !== null) {
          attachmentMap.delete(m[1]!);
        }
        saveEntry(resolvedText);
        void onSubmit?.(buildPromptSubmission(resolvedText, commands));
        setEditorState({ text: "", cursorOffset: 0 });
        setDismissedQuery(null);
        setSelectedIndex(0);
        setFirstMessage(false);
        setPasteFolded(false);
        return;
      }

      // Paste fold guard: restrict editing while paste placeholders exist
      if (pasteFoldedRef.current) {
        if (input === ' ') {
          const resolved = resolvePastePlaceholders(editorStateRef.current.text);
          updateEditorState({ text: resolved, cursorOffset: resolved.length });
          setPasteFolded(false);
          return;
        }
        if (key.backspace || key.delete) {
          const markerRe = createPasteMarkerRe();
          let match: RegExpExecArray | null;
          let markerToRemove: { id: string; start: number; end: number } | null = null;
          while ((match = markerRe.exec(editorStateRef.current.text)) !== null) {
            const mStart = match.index;
            const mEnd = mStart + match[0].length;
            const cursor = editorStateRef.current.cursorOffset;
            const inside = key.backspace
              ? cursor > mStart && cursor <= mEnd
              : cursor >= mStart && cursor < mEnd;
            if (inside) { markerToRemove = { id: match[1]!, start: mStart, end: mEnd }; break; }
          }
          if (markerToRemove) {
            const before = editorStateRef.current.text.slice(0, markerToRemove.start);
            const after = editorStateRef.current.text.slice(markerToRemove.end);
            attachmentMap.delete(markerToRemove.id);
            updateEditorState({ text: before + after, cursorOffset: markerToRemove.start });
            if (!hasPasteMarkers(before + after)) {
              setPasteFolded(false);
            }
          } else {
            updateEditorState(prev => removeCharacterBeforeCursor(prev));
          }
          return;
        }
        if (!key.leftArrow && !key.rightArrow && !key.upArrow && !key.downArrow) return;
      }

      if (key.leftArrow) {
        updateEditorState(prev => moveCursorLeft(prev));
        return;
      }

      if (key.rightArrow) {
        updateEditorState(prev => moveCursorRight(prev));
        return;
      }

      // Ink v5 maps both \x7f (backspace) and \x1b[3~ (delete) to key.delete.
      // \b maps to key.backspace but is rarely sent by modern terminals.
      // Since backspace is far more common than delete, use removeBefore for key.delete.
      if (key.backspace || key.delete) {
        exitBrowsing();
        updateEditorState(prev => removeCharacterBeforeCursor(prev));
        return;
      }

      if (!pickerOpen && (editorStateRef.current.text === "" || isBrowsing) && key.upArrow) {
        if (!isBrowsing) beginBrowsing(editorStateRef.current.text);
        const entry = browseUp();
        if (entry !== null) {
          setEditorState({ text: entry, cursorOffset: entry.length });
        }
        return;
      }

      if (!pickerOpen && isBrowsing && key.downArrow) {
        const entry = browseDown();
        if (entry !== null) {
          setEditorState({ text: entry, cursorOffset: entry.length });
        }
        return;
      }

      if (key.upArrow || key.downArrow) {
        return;
      }

      // Detect tagged paste chunk from PasteBufferingStdin
      // Use [\w-]+ instead of \w+ because nanoid may generate IDs with hyphens
      const pasteMatch = /^\x01PASTE\x01([\w-]+)\x01([\s\S]*?)\x01$/.exec(input);
      if (pasteMatch) {
        const id = pasteMatch[1]!;
        const content = pasteMatch[2]!;
        const lineCount = content.split('\n').length;
        // Only fold substantial pastes; small snippets are inserted directly
        if (lineCount > PASTE_FOLD_LINE_THRESHOLD || content.length > PASTE_FOLD_CHAR_THRESHOLD) {
          attachmentMap.set(id, content);
          exitBrowsing();
          const marker = createPasteMarker(id);
          updateEditorState(prev => insertTextAtCursor(prev, marker));
          setPasteFolded(true);
        } else {
          exitBrowsing();
          updateEditorState(prev => insertTextAtCursor(prev, content));
        }
        return;
      }

      exitBrowsing();
      updateEditorState(prev => insertTextAtCursor(prev, input));
    },
    { isActive: true },
  );

  return {
    filteredCommands,
    highlightedCommandName,
    pickerOpen,
    placeholder: firstMessage ? welcomeMessage : "Input anything to continue. Launch a new command or skill by typing `/`",
    selectedIndex,
    text: editorState.text,
    cursorOffset: editorState.cursorOffset,
    displayText,
    displayCursorOffset,
    pasteFolded,
    pasteLineCount,
    atFiles,
    atSelectedIndex,
    atFilePickerOpen,
  };
}
