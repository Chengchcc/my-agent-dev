DELETE FROM settings WHERE key IN (
  'conversation.maxHops',
  'loop.generatorModel',
  'loop.evaluatorModel',
  'loop.defaultAcceptance',
  'loop.defaultDailyCap',
  'loop.defaultDenylist'
);
