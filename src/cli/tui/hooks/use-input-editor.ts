import { useState } from 'react';

export interface InputEditorState {
  text: string;
  cursorOffset: number;
}

export function insertTextAtCursor(state: InputEditorState, input: string): InputEditorState {
  if (input.length === 0) return state;

  return {
    text: state.text.slice(0, state.cursorOffset) + input + state.text.slice(state.cursorOffset),
    cursorOffset: state.cursorOffset + input.length,
  };
}

export function removeCharacterBeforeCursor(state: InputEditorState): InputEditorState {
  if (state.cursorOffset === 0) return state;

  return {
    text: state.text.slice(0, state.cursorOffset - 1) + state.text.slice(state.cursorOffset),
    cursorOffset: state.cursorOffset - 1,
  };
}

export function moveCursorLeft(state: InputEditorState): InputEditorState {
  return {
    ...state,
    cursorOffset: Math.max(0, state.cursorOffset - 1),
  };
}

export function moveCursorRight(state: InputEditorState): InputEditorState {
  return {
    ...state,
    cursorOffset: Math.min(state.text.length, state.cursorOffset + 1),
  };
}

export function useInputEditor() {
  const [editorState, setEditorState] = useState<InputEditorState>({
    text: '',
    cursorOffset: 0,
  });

  const updateEditor = (next: InputEditorState) => {
    setEditorState(next);
  };

  return {
    editorState,
    updateEditor,
    insertText: (input: string) => updateEditor(insertTextAtCursor(editorState, input)),
    removeCharacter: () => updateEditor(removeCharacterBeforeCursor(editorState)),
    moveLeft: () => updateEditor(moveCursorLeft(editorState)),
    moveRight: () => updateEditor(moveCursorRight(editorState)),
    clear: () => updateEditor({ text: '', cursorOffset: 0 }),
  };
}
