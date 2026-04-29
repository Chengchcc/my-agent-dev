import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';

const BPM_START = '\x1b[200~';
const BPM_END = '\x1b[201~';
const PASTE_SENTINEL = '\x01';
const MAX_PASTE_SIZE = 5 * 1024 * 1024; // 5 MB

type BpmState = 'normal' | 'in_paste';

function partialMarkerLen(str: string): number {
  let maxLen = 0;
  for (const marker of [BPM_START, BPM_END]) {
    for (let len = 1; len <= Math.min(str.length, marker.length - 1); len++) {
      if (marker.startsWith(str.slice(-len))) {
        maxLen = Math.max(maxLen, len);
      }
    }
  }
  return maxLen;
}

export class PasteBufferingStdin extends EventEmitter {
  private stdin: NodeJS.ReadStream;
  private state: BpmState = 'normal';
  private incoming = '';
  private pasteBuffer = '';
  private readQueue: string[] = [];
  private dataListenerBound = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stdin: NodeJS.ReadStream = process.stdin) {
    super();
    this.stdin = stdin;
  }

  // TTY delegation
  get isTTY(): boolean { return this.stdin.isTTY; }
  setRawMode(mode: boolean): void { this.stdin.setRawMode(mode); }
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  setEncoding(encoding: string): void { this.stdin.setEncoding(encoding as BufferEncoding); }
  ref(): void { this.stdin.ref(); }
  unref(): void { this.stdin.unref(); }

  // Event listener interception
  override addListener(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'readable') {
      super.on('readable', listener);
      this.ensureDataListener();
    }
    return this;
  }

  override removeListener(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'readable') {
      super.off('readable', listener);
      if (this.listenerCount('readable') === 0) {
        this.stdin.off('data', this.handleData);
        this.dataListenerBound = false;
      }
    }
    return this;
  }

  read(): string | null {
    return this.readQueue.shift() ?? null;
  }

  private ensureDataListener(): void {
    if (this.dataListenerBound) return;
    this.stdin.on('data', this.handleData);
    this.dataListenerBound = true;
  }

  private handleData = (chunk: string | Buffer): void => {
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    this.incoming += raw;
    this.processIncoming();
    this.drainTail();
    this.tryEmit();
  };

  private tryEmit(): void {
    if (this.readQueue.length > 0) this.emit('readable');
  }

  private processIncoming(): void {
    let prevLen: number;
    do {
      prevLen = this.incoming.length;
      if (this.state === 'normal') {
        this.processNormal();
      } else {
        this.processPaste();
      }
    } while (this.incoming.length > 0 && this.incoming.length < prevLen);
  }

  private processNormal(): void {
    const idx = this.incoming.indexOf(BPM_START);
    if (idx < 0) {
      const keep = partialMarkerLen(this.incoming);
      if (keep > 0 && this.incoming.length > keep) {
        this.push(this.incoming.slice(0, this.incoming.length - keep));
        this.incoming = this.incoming.slice(-keep);
      } else if (keep === 0) {
        this.push(this.incoming);
        this.incoming = '';
      }
      return;
    }
    if (idx > 0) {
      this.push(this.incoming.slice(0, idx));
    }
    this.incoming = this.incoming.slice(idx + BPM_START.length);
    this.state = 'in_paste';
    this.pasteBuffer = '';
  }

  private processPaste(): void {
    if (this.pasteBuffer.length > MAX_PASTE_SIZE) {
      this.incoming = '';
      this.state = 'normal';
      this.pasteBuffer = '';
      return;
    }
    const idx = this.incoming.indexOf(BPM_END);
    if (idx < 0) {
      const keep = partialMarkerLen(this.incoming);
      const safeLen = this.incoming.length - keep;
      if (safeLen > 0) {
        this.pasteBuffer += this.incoming.slice(0, safeLen);
        this.incoming = this.incoming.slice(safeLen);
      }
      return;
    }
    this.pasteBuffer += this.incoming.slice(0, idx);
    this.incoming = this.incoming.slice(idx + BPM_END.length);
    this.state = 'normal';

    if (this.pasteBuffer.length > 0) {
      const id = nanoid(6);
      this.push(`${PASTE_SENTINEL}PASTE${PASTE_SENTINEL}${id}${PASTE_SENTINEL}${this.pasteBuffer}${PASTE_SENTINEL}`);
    }
  }

  private drainTail(): void {
    if (this.incoming.length === 0) return;

    if (partialMarkerLen(this.incoming) > 0) {
      // Hold briefly — could be a BPM marker split across chunks
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.incoming.length > 0) {
          this.push(this.incoming);
          this.incoming = '';
          this.tryEmit();
        }
      }, 50);
    } else {
      this.push(this.incoming);
      this.incoming = '';
    }
  }

  private push(chunk: string): void {
    if (chunk.length > 0) this.readQueue.push(chunk);
  }
}
