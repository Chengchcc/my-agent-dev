/** --tools filter (CLI): comma-separated tool names; plain names form a
 *  whitelist (ONLY those run), `!name` entries form a blacklist. Applied to
 *  the FINAL tool table (native + MCP + plugin) at Run assembly. */

export interface ToolFilter {
  /** Present = whitelist mode: only these tools run. */
  readonly allow?: ReadonlySet<string>;
  /** Blacklist mode (entries given with `!`): all tools except these. */
  readonly deny?: ReadonlySet<string>;
}

export function parseToolFilter(spec: string): ToolFilter {
  const names = spec
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const deny = names.filter((n) => n.startsWith("!")).map((n) => n.slice(1));
  const allow = names.filter((n) => !n.startsWith("!"));
  if (allow.length > 0) return { allow: new Set(allow) };
  if (deny.length > 0) return { deny: new Set(deny) };
  return {};
}

export function toolFilterAllows(filter: ToolFilter, toolName: string): boolean {
  if (filter.allow) return filter.allow.has(toolName);
  if (filter.deny) return !filter.deny.has(toolName);
  return true;
}
