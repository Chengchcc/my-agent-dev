export function ToolResultCard({
  content,
  isError,
}: {
  toolUseId?: string;
  content: string;
  isError?: boolean;
}) {
  return (
    <div
      className={`border rounded-lg bg-(--canvas) my-2 overflow-hidden ${
        isError ? "border-destructive/30" : "border-(--hairline)"
      }`}
    >
      <div className="p-3">
        <p className="text-[10px] tracking-[0.15em] uppercase font-sans font-semibold text-(--mute) mb-1">
          Result
        </p>
        <pre
          className={`text-[13px] whitespace-pre-wrap max-h-40 overflow-y-auto font-mono ${
            isError ? "text-(--body)" : "text-(--canvas-text-soft)"
          }`}
        >
          {content}
        </pre>
      </div>
    </div>
  );
}
