# ADR 0026: Agent trust model for the local single-user product

Status: accepted

## Context

The audit (2026-08) flagged a fork in the road: is the agent (and the CLI
children it controls) a trusted local process or an untrusted execution
surface? Every security decision downstream — bash tool constraints, MCP
credential storage, login policy — depends on this answer. The product is
today a single-user localhost workbench; the question only becomes
load-bearing when it moves to a LAN or hosted deployment.

## Decision

Current posture: **single-user local product, agents treated as
semi-trusted.** We do not defend against a malicious local user attacking
their own machine, but we DO defend against:

- a prompt-injected agent exfiltrating host secrets it never needed;
- cross-process credential leaks (`ps`, env inheritance, stderr tails);
- drive-by remote access to the web surface.

Concretely, the following are in force:

1. Spawned agent CLIs receive an allowlisted env (`childEnv`), never the
   parent's full environment.
2. Backend auth tokens travel via env, never argv.
3. `read_image` and file tools enforce a workspace sandbox (realpath +
   boundary check).
4. Login fails closed without a configured `MOCK_PASSWORD`; comparison is
   constant-time; failures are rate-limited per IP.
5. Subagent roles (`task` registry) may only narrow the executor's tool
   set, never widen it; model overrides must resolve in the catalog.

Not yet decided (LAN/hosted follow-up, would flip agents to untrusted):

- bash tool command constraints beyond cwd checks;
- encrypted-at-rest MCP env/headers;
- removal of the mock login surface.

## Consequences

- Local-hosted today, with the LAN ticket partially paid (login + secret
  hygiene done).
- When moving to a network, re-review this ADR and upgrade the listed
  follow-ups before exposing the surface.
