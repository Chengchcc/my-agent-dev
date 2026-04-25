import { describe, it, expect } from 'bun:test';
import { createToolSink } from '../../../src/agent/tool-dispatch/types';

describe('ToolSink', () => {
  describe('_todoUpdates', () => {
    it('should be undefined when updateTodos was never called', () => {
      const sink = createToolSink();
      expect(sink._todoUpdates).toBeUndefined();
    });

    it('should return the todos after updateTodos is called', () => {
      const sink = createToolSink();
      const todos = [{ id: '1', text: 'test', completed: false }];
      sink.updateTodos(todos);
      expect(sink._todoUpdates).toEqual(todos);
    });
  });
});
