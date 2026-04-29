import { useEffect } from 'react';

const ENABLE_BPM = '\x1b[?2004h';
const DISABLE_BPM = '\x1b[?2004l';

export function useBracketedPaste(): void {
  useEffect(() => {
    process.stdout.write(ENABLE_BPM);
    return () => {
      process.stdout.write(DISABLE_BPM);
    };
  }, []);
}
