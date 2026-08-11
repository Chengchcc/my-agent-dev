"use client";

interface MemoryFile {
  file: string;
  content: string;
}

interface AgentMemory {
  memories: MemoryFile[];
  memSummary: string | null;
  memoryMd: string | null;
}

export function MemoryPanel({ memory }: { memory: AgentMemory }) {
  if (!memory) return <div className="text-sm text-(--mute)">Loading...</div>;

  return (
    <div className="space-y-6">
      {memory.memSummary && (
        <div>
          <h3 className="text-[10px] tracking-widest uppercase text-(--mute) mb-2">Summary</h3>
          <pre className="text-sm whitespace-pre-wrap text-(--ink)">{memory.memSummary}</pre>
        </div>
      )}

      <div>
        <h3 className="text-[10px] tracking-widest uppercase text-(--mute) mb-2">
          Facts ({memory.memories.length})
        </h3>
        {memory.memories.length === 0 ? (
          <p className="text-sm text-(--mute)">No memories extracted yet.</p>
        ) : (
          <div className="space-y-3">
            {memory.memories.map((m) => (
              <div key={m.file} className="rounded border border-(--hairline) p-3">
                <p className="text-[10px] text-(--mute) mb-1">{m.file}</p>
                <pre className="text-sm whitespace-pre-wrap text-(--ink) max-h-32 overflow-y-auto">
                  {m.content}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
