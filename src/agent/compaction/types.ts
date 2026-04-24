import type { Message } from '../../types';

export interface CompactionResult {
  messages: Message[];
  level: 'none' | 'light' | 'moderate' | 'heavy' | 'unknown';
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
}
