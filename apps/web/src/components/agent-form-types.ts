import { z } from "zod";

export const agentFormSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required"),
  backendKind: z.string().trim().min(1, "Backend is required"),
  model: z.string().trim().min(1, "Model is required"),
  reasoningEffort: z.enum(["", "none", "low", "high", "max"]).default(""),
  permissionMode: z.enum(["ask", "auto", "deny"]).default("ask"),
  maxSteps: z.string().trim().default(""),
  workspacePath: z.string().trim().default(""),
  enableLark: z.boolean().default(false),
  botDisplayName: z.string().trim().default(""),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;
