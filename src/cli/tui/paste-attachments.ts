const MARKER_PREFIX = '\u27EA'; // ⟪ (mathematical left angle bracket)
const MARKER_SUFFIX = '\u27EB'; // ⟫ (mathematical right angle bracket)

export const attachmentMap = new Map<string, string>();

/** Returns a fresh RegExp for matching paste markers. Always use 'g' flag — never reuse across iterations. */
export function createPasteMarkerRe(): RegExp {
  // Use [\w-]+ instead of \w+ because nanoid may generate IDs with hyphens
  return new RegExp(`${MARKER_PREFIX}Paste:([\\w-]+)${MARKER_SUFFIX}`, 'g');
}

/** Returns true if text contains any paste marker. */
export function hasPasteMarkers(text: string): boolean {
  return text.indexOf(MARKER_PREFIX) !== -1;
}

export function clearAttachments(): void {
  attachmentMap.clear();
}

export function createPasteMarker(id: string): string {
  return `${MARKER_PREFIX}Paste:${id}${MARKER_SUFFIX}`;
}

export function resolvePastePlaceholders(text: string): string {
  // Use [\w-]+ instead of \w+ because nanoid may generate IDs with hyphens
  return text.replace(new RegExp(`${MARKER_PREFIX}Paste:([\\w-]+)${MARKER_SUFFIX}`, 'g'), (_match, id) => {
    return attachmentMap.get(id as string) ?? _match;
  });
}

export function getFoldedDisplay(
  text: string,
  cursorOffset: number,
): { displayText: string; displayCursorOffset: number; totalPasteLines: number } {
  // Use [\w-]+ instead of \w+ because nanoid may generate IDs with hyphens
  const markerRe = new RegExp(`${MARKER_PREFIX}Paste:([\\w-]+)${MARKER_SUFFIX}`, 'g');
  let match: RegExpExecArray | null;
  let displayText = '';
  let lastEnd = 0;
  let totalPasteLines = 0;
  let displayCursorOffset = cursorOffset;

  while ((match = markerRe.exec(text)) !== null) {
    const content = attachmentMap.get(match[1]!) ?? '';
    const lines = Math.max(1, content.split('\n').length);
    totalPasteLines += lines;
    const placeholder = `[Pasted ${lines} lines]`;

    displayText += text.slice(lastEnd, match.index);

    if (cursorOffset >= match.index + match[0].length) {
      displayCursorOffset += placeholder.length - match[0].length;
    } else if (cursorOffset > match.index) {
      displayCursorOffset = displayText.length;
    }

    displayText += placeholder;
    lastEnd = match.index + match[0].length;
  }

  displayText += text.slice(lastEnd);
  return { displayText, displayCursorOffset, totalPasteLines };
}
