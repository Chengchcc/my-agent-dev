// src/cli/tui/hooks/use-ask-user-question-manager.ts
import { useEffect, useState } from 'react';
import {
  globalAskUserQuestionManager,
  type AskUserQuestionRequest,
  type AskUserQuestionResult,
} from '../../../tools';

export function useAskUserQuestionManager() {
  const [request, setRequest] = useState<AskUserQuestionRequest | null>(null);

  useEffect(() => {
    return globalAskUserQuestionManager.subscribe((req) => {
      setRequest(req);
    });
  }, []);

  const respondWithAnswers = (result: AskUserQuestionResult) => {
    if (request) {
      globalAskUserQuestionManager.respondWithAnswers(result);
    }
  };

  return {
    askUserQuestionRequest: request,
    respondWithAnswers,
  };
}
