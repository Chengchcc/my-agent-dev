import type { AskUserQuestionParameters, AskUserQuestionResult } from './ask-user-question';

export class AskUserQuestionManager {
  private static instance: AskUserQuestionManager;

  private constructor() {}

  public static getInstance(): AskUserQuestionManager {
    if (!AskUserQuestionManager.instance) {
      AskUserQuestionManager.instance = new AskUserQuestionManager();
    }
    return AskUserQuestionManager.instance;
  }

  public async ask(params: AskUserQuestionParameters): Promise<AskUserQuestionResult> {
    throw new Error('AskUserQuestionManager.ask not implemented yet');
  }
}
