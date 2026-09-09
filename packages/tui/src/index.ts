// Core TUI interfaces and classes
// Vendored from @earendil-works/pi-tui (MIT, https://github.com/earendil-works/pi)
// Trimmed for oma: no fuzzy, no settings-list, no cancellable-loader, no image component.

// Autocomplete support (editor dependency)
export {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "./autocomplete.ts";
// Components
export { AnsiConsole } from "./components/ansi-console.ts";
export { Box } from "./components/box.ts";
export { Card, type CardOptions } from "./components/card.ts";
export {
  Editor,
  type EditorOptions,
  type EditorTheme,
} from "./components/editor.ts";
export { Input } from "./components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
export {
  type DefaultTextStyle,
  Markdown,
  type MarkdownOptions,
  type MarkdownTheme,
} from "./components/markdown.ts";
export {
  CachedOutputBlock,
  type OutputBlockOptions,
  type OutputBlockSection,
  type OutputBlockState,
  outputBlockContentWidth,
  renderOutputBlock,
} from "./components/output-block.ts";
export {
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { Spacer } from "./components/spacer.ts";
export {
  chip,
  renderStatusBar,
  renderToolHeader,
  type StatusSegment,
} from "./components/statusline.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.ts";
// Keybindings
export {
  getKeybindings,
  type Keybinding,
  type KeybindingConflict,
  type KeybindingDefinition,
  type KeybindingDefinitions,
  type Keybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "./keybindings.ts";
// Keyboard input handling
export {
  decodeKittyPrintable,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  type KeyEventType,
  type KeyId,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from "./keys.ts";
// SGR mouse reports (wheel scroll routing)
export {
  parseSgrMouse,
  routeSgrMouseInput,
  type SgrMouseEvent,
  type SgrMouseHandler,
} from "./mouse.ts";
// Input buffering for batch splitting
export {
  StdinBuffer,
  type StdinBufferEventMap,
  type StdinBufferOptions,
} from "./stdin-buffer.ts";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal.ts";
// Terminal colors
export {
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
  type RgbColor,
  type TerminalColorScheme,
} from "./terminal-colors.ts";
// Terminal image helpers (used internally by tui.ts)
export {
  deleteKittyImage,
  getCapabilities,
  isImageLine,
  setCellDimensions,
} from "./terminal-image.ts";
export {
  type Component,
  Container,
  CURSOR_MARKER,
  type Focusable,
  type FramePlan,
  getNativeScrollbackLiveRegionStart,
  getRenderStablePrefixRows,
  type HistoryBatch,
  isFocusable,
  type NativeScrollbackCommittedRows,
  type NativeScrollbackLiveRegion,
  type NativeScrollbackReplay,
  type OverlayAnchor,
  type OverlayHandle,
  type OverlayMargin,
  type OverlayOptions,
  type OverlayUnfocusOptions,
  prepareNativeScrollbackReplay,
  type RenderStablePrefix,
  type SizeValue,
  setNativeScrollbackCommittedRows,
  type TerminalFrameProvider,
  TUI,
  type ViewportTailProvider,
} from "./tui.ts";
// Utilities
export {
  applyBackgroundToLine,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./utils.ts";
export { VirtualTerminal } from "./virtual-terminal.ts";
