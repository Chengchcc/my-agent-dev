-- 0022: reasoning effort on agents. Optional per-agent thinking-mode effort
-- (none/low/high/max), plumbed through the run model ref to the provider's
-- Anthropic thinking config. Null = provider default.
ALTER TABLE `agents` ADD COLUMN `reasoning_effort` text;
