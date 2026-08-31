/** Display title for a conversation row. Never surface the raw id hash:
 *  fall back to the last message preview, then a neutral placeholder. */
export function conversationDisplayName(conv: {
  title?: string | null;
  lastMessagePreview?: string | null;
}): string {
  const title = conv.title?.trim();
  if (title) return title;
  const preview = conv.lastMessagePreview?.trim();
  if (preview) return preview;
  return "New conversation";
}
