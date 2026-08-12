import { z } from "zod";

/** The full set of execution backends the Product Backend can dispatch to.
 *  Each kind has exactly one adapter package implementing `AgentBackend<K>`:
 *  - coding_agent: 自家 child (apps/coding-agent --mode rpc)
 *  - claude_code:   Claude Code CLI (--output-format stream-json)
 *  - pi:            pi CLI (@earendil-works/pi-coding-agent, -p --mode json)
 *  - omp:           omp CLI (@oh-my-pi/pi-coding-agent, -p --mode json)
 *
 *  The wire contract in transport.ts accepts this union; a child enforces
 *  its own kind at runtime (see coding-agent rpc-mode). */
export const BACKEND_KINDS = ["coding_agent", "claude_code", "pi", "omp"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export const backendKindSchema = z.enum(BACKEND_KINDS);
