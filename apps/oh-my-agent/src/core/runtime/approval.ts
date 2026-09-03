/** HITL approval (spec: 2026-08-26-plugin-trust-model-design.md): one handler
 *  type, three resolution pipelines (tui overlay / print+json fail-closed /
 *  rpc wire with deadline). */

export interface ApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** Who asked: "permission" (ask-mode gate), "tool" (options.request), or
   *  "classifier" (auto-mode block escalated to the human). */
  readonly source: "permission" | "tool" | "classifier";
  readonly reason?: string;
}

export interface ApprovalDecision {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export function approvalTimeoutMs(): number {
  const raw = process.env.OMA_APPROVAL_TIMEOUT_MS;
  const n = raw === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** Resolve with a deadline; a silent human fails closed (deny). 0 = wait. */
export function withApprovalDeadline(
  p: Promise<ApprovalDecision>,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  if (timeoutMs === 0) return p;
  return Promise.race([
    p,
    new Promise<ApprovalDecision>((resolve) =>
      setTimeout(
        () => resolve({ decision: "deny", reason: "approval deadline exceeded" }),
        timeoutMs,
      ),
    ),
  ]);
}

/** The fail-closed handler for headless one-shot modes (print/json). */
export function denyAllApprovals(req: ApprovalRequest): Promise<ApprovalDecision> {
  return Promise.resolve({
    decision: "deny",
    reason: `${req.toolName}: approval requested in non-interactive mode (fail-closed)`,
  });
}
