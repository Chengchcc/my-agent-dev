import { useInput } from "ink";
import { useEffect, useMemo, useState, useRef } from "react";
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

export function useCommandInput({
  commands,
  onSubmit,
  onAbort,
}: {
  commands: SlashCommand[];
  onSubmit?: (submission: PromptSubmission) => void | Promise<void>;
  onAbort?: () => void;
}) {
  const [firstMessage, setFirstMessage] = useState(true);
  const [editorState, setEditorState] = useState<InputEditorState>({ text: "", cursorOffset: 0 });
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pasteFolded, setPasteFolded] = useState(false);
  const [pasteLineCount, setPasteLineCount] = useState(0);
  const [welcomeMessage] = useState(
    () => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)] ?? "What's on your mind?",
  );
  const { isBrowsing, browseUp, browseDown, exitBrowsing, saveEntry } = useInputHistory();
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;

  const slashQuery = getSlashQuery(editorState.text);
  const filteredCommands = useMemo(
    () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),
    [commands, slashQuery],
  );
  const pickerOpen = slashQuery !== null && dismissedQuery !== slashQuery;
  const highlightedCommandName = getHighlightedCommandName(editorState.text, commands);

  useEffect(() => {
    setSelectedIndex((currentIndex) => {
      if (filteredCommands.length === 0) return 0;
      return Math.min(currentIndex, filteredCommands.length - 1);
    });
  }, [filteredCommands.length]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  const updateEditorState = (next: InputEditorState | ((prev: InputEditorState) => InputEditorState)) => {
    if (typeof next === 'function') {
      setEditorState((prevState) => {
        const newState = next(prevState);
        // Calculate new text for slash query check using the actual new state
        const newText = newState.text;
        if (getSlashQuery(newText) !== dismissedQuery) {
          setDismissedQuery(null);
        }
        return newState;
      });
    } else {
      setEditorState(next);
      // Calculate new text for slash query check
      const newText = next.text;
      if (getSlashQuery(newText) !== dismissedQuery) {
        setDismissedQuery(null);
      }
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
    (input, key) => {
      if (key.ctrl && input === "c") {
        onAbort?.();
        return;
      }

      if (pickerOpen && key.escape) {
        setDismissedQuery(slashQuery);
        return;
      }

      if (key.escape) {
        if (editorStateRef.current.text.length > 0) {
          exitBrowsing();
          setEditorState({ text: '', cursorOffset: 0 });
          setDismissedQuery(null);
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
            // Reopen picker so user sees all options
            setDismissedQuery(null);
          }
        }
        return;
      }

      if (key.return) {
        if (key.shift) {
          // Insert newline instead of submitting
          exitBrowsing();
          updateEditorState(prev => insertTextAtCursor(prev, '\n'));
          return;
        }

        // Regular enter - submit
        saveEntry(editorStateRef.current.text);
        onSubmit?.(buildPromptSubmission(editorStateRef.current.text, commands));
        setEditorState({ text: "", cursorOffset: 0 });
        setDismissedQuery(null);
        setSelectedIndex(0);
        setFirstMessage(false);
        return;
      }

      if (key.leftArrow) {
        updateEditorState(prev => moveCursorLeft(prev));
        return;
      }

      if (key.rightArrow) {
        updateEditorState(prev => moveCursorRight(prev));
        return;
      }

      if (key.backspace || key.delete) {
        exitBrowsing();
        updateEditorState(prev => removeCharacterBeforeCursor(prev));
        return;
      }

      if (!pickerOpen && (editorStateRef.current.text === "" || isBrowsing) && key.upArrow) {
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

      // Paste folding: Space toggles expand when folded
      if (pasteFolded && input === ' ') {
        setPasteFolded(false);
        return;
      }

      exitBrowsing();
      updateEditorState(prev => {
        const next = insertTextAtCursor(prev, input);
        const lines = next.text.split('\n').length;
        if (lines >= 3 && !pasteFolded) {
          setPasteFolded(true);
          setPasteLineCount(lines);
        }
        return next;
      });
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
    pasteFolded,
    pasteLineCount,
  };
}
