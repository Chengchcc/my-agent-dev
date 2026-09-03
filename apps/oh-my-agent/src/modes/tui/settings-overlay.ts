import {
  applyBackgroundToLine,
  Container,
  Input,
  SelectList,
  type SelectListTheme,
  truncateToWidth,
} from "@chengchenccc/tui";
import type { ProjectSettings } from "../../core/settings/project-settings.js";

type SettingKey = keyof ProjectSettings;

interface SettingRow {
  key: SettingKey;
  label: string;
  kind: "boolean" | "number" | "string";
}

const OVERLAY_BG = (s: string): string => `\u001b[48;5;235m${s}\u001b[0m`;

function overlayLines(lines: readonly string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 2);
  return lines.map((line) => {
    const content = truncateToWidth(line, innerWidth, "", true);
    return `\u001b[36m\u2502\u001b[0m${applyBackgroundToLine(content, innerWidth, OVERLAY_BG)}\u001b[36m\u2502\u001b[0m`;
  });
}

const THEME: SelectListTheme = {
  selectedPrefix: (s) => `\u001b[36m${s}\u001b[0m`,
  selectedText: (s) => `\u001b[1m${s}\u001b[0m`,
  description: (s) => `\u001b[2m${s}\u001b[0m`,
  scrollInfo: (s) => `\u001b[2m${s}\u001b[0m`,
  noMatch: (s) => `\u001b[2m${s}\u001b[0m`,
};

const ROWS: SettingRow[] = [
  { key: "maxSteps", label: "maxSteps", kind: "number" },
  { key: "modelTimeoutMs", label: "modelTimeoutMs", kind: "number" },
  { key: "mcpTimeoutMs", label: "mcpTimeoutMs", kind: "number" },
  { key: "bashTimeoutMs", label: "bashTimeoutMs", kind: "number" },
  { key: "maxToolTimeoutMs", label: "maxToolTimeoutMs", kind: "number" },
  { key: "bashSandbox", label: "bashSandbox (OS sandbox: bwrap/Seatbelt)", kind: "boolean" },
  { key: "memoryExtract", label: "memoryExtract", kind: "boolean" },
  { key: "memoryModel", label: "memoryModel", kind: "string" },
  { key: "permissionClassifierModel", label: "permissionClassifierModel", kind: "string" },
  { key: "titleEnabled", label: "titleEnabled", kind: "boolean" },
  { key: "disableWeb", label: "disableWeb", kind: "boolean" },
  { key: "enableClaude", label: "enableClaude", kind: "boolean" },
  { key: "enableCodex", label: "enableCodex", kind: "boolean" },
  { key: "enableAgents", label: "enableAgents", kind: "boolean" },
];

function rowValue(settings: ProjectSettings, key: SettingKey): string {
  const v = settings[key];
  if (typeof v === "boolean") return v ? "on" : "off";
  if (v === undefined || v === null || v === "") return "(unset)";
  if (Array.isArray(v)) return v.length > 0 ? `${v.length} dirs` : "(none)";
  return String(v);
}

/** Modal settings editor (omp SettingsSelector-container-inspired but lean):
 *  a SelectList of rows; Enter toggles booleans or opens a text Input for
 *  numeric/string values; Esc closes. Changes are held in a local copy. */
export class SettingsOverlay extends Container {
  private readonly settings: ProjectSettings;
  private list!: SelectList;
  private readonly listSlot: Container = new Container();
  private editing: { row: SettingRow; input: Input } | null = null;

  constructor(
    settings: ProjectSettings,
    private readonly onDone: () => void,
  ) {
    super();
    this.settings = { ...settings };
    this.rebuild();
  }

  getSettings(): ProjectSettings {
    return this.settings;
  }

  private displayValue(key: SettingKey): string {
    return rowValue(this.settings, key);
  }

  private itemFor(row: SettingRow): { value: string; label: string; description: string } {
    return {
      value: row.key,
      label: row.label,
      description: `${row.kind} · ${this.displayValue(row.key)}`,
    };
  }

  private rebuild(): void {
    this.list = new SelectList(
      ROWS.map((row) => this.itemFor(row)),
      12,
      THEME,
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 24 },
    );
    this.list.onSelect = (item) => {
      const row = ROWS.find((r) => r.key === item.value);
      if (row) this.handleSelect(row);
    };
    this.list.onCancel = () => this.onDone();
    this.listSlot.clear();
    this.listSlot.addChild(this.list);
    this.invalidate();
  }

  private handleSelect(row: SettingRow): void {
    if (row.kind === "boolean") {
      const current = this.settings[row.key];
      const next = typeof current === "boolean" ? !current : true;
      Reflect.set(this.settings, row.key, next);
      this.rebuild();
      return;
    }
    this.beginEdit(row);
  }

  private beginEdit(row: SettingRow): void {
    const input = new Input();
    input.setValue(this.displayValue(row.key) === "(unset)" ? "" : String(this.settings[row.key]));
    input.onSubmit = () => {
      this.commitEdit(row, input.getValue());
    };
    input.onEscape = () => {
      this.editing = null;
      this.invalidate();
    };
    this.editing = { row, input };
    this.invalidate();
  }

  private commitEdit(row: SettingRow, raw: string): void {
    let value: unknown = raw.trim();
    if (row.kind === "number") {
      const parsed = Number(raw.trim());
      if (!Number.isFinite(parsed)) {
        this.editing = null;
        this.invalidate();
        return;
      }
      value = parsed;
    }
    Reflect.set(this.settings, row.key, value);
    this.editing = null;
    this.rebuild();
  }

  handleInput(data: string): void {
    if (this.editing) {
      this.editing.input.handleInput(data);
      return;
    }
    this.list.handleInput(data);
  }

  override render(width: number): string[] {
    const lines: string[] = [];
    lines.push("  settings — enter to edit, esc to close");
    if (this.editing) {
      lines.push(`  edit ${this.editing.row.label} (${this.editing.row.kind}):`);
      lines.push(...this.editing.input.render(Math.max(1, width - 4)));
    }
    lines.push(...this.list.render(Math.max(1, width - 2)));
    return overlayLines(lines, width);
  }
}
