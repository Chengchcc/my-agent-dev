/** Translate workflow execution errors into human sentences: which node,
 *  what is missing, what to do. Falls back to the raw message. */

export interface HumanizedError {
  title: string;
  detail?: string;
}

export function humanizeWorkflowError(
  error: string | undefined,
  nodeRuns: Array<{ nodeId: string; status: string; error?: string }>,
): HumanizedError | null {
  if (!error) return null;

  const m = /node (\S+) missing required input artifact: (\S+)/.exec(error);
  if (m) {
    return {
      title: `Artifact required by node ${m[1]} does not exist`,
      detail: `You must provide ${m[2]} before running. Upload it on the Artifacts page, or pick the correct address in the input field at run time.`,
    };
  }

  const a = /workflow (\S+) input artifact (\S+) does not exist: (\S+)/.exec(error);
  if (a) {
    return {
      title: `Input artifact ${a[2]} does not exist`,
      detail: `The ${a[3]} provided for this run was not found in the artifact store. Upload it first, or check the address spelling.`,
    };
  }

  const o = /node (\S+) missing required output artifact: (\S+)/.exec(error);
  if (o) {
    return {
      title: `Node ${o[1]} did not produce the declared artifact`,
      detail: `This node promised to produce ${o[2]}, but it does not exist after execution. The agent needs to call artifact_upload to upload the artifact before the workflow can continue.`,
    };
  }

  const s = /node (\S+) output invalid: (.+)/.exec(error);
  if (s) {
    return {
      title: `Node ${s[1]} output format is invalid`,
      detail: `${s[2]}. Relax the output declaration in the node properties, or adjust the prompt so the agent outputs as required, then retry.`,
    };
  }

  const sc = /script failed \(exit \d+\): (.+)/s.exec(error);
  if (sc) {
    const failed = nodeRuns.find((r) => r.status === "failed");
    return {
      title: `Script node ${failed?.nodeId ?? "?"} failed`,
      detail: sc[1]!.split("\n")[0]!.slice(0, 200),
    };
  }

  const ag = /agent run (\S+) ended (failed|aborted|timeout|commit_failed)/.exec(error);
  if (ag) {
    const failed = nodeRuns.find((r) => r.status === "failed");
    return {
      title: `Agent node ${failed?.nodeId ?? "?"} ${ag[2] === "timeout" ? "timed out" : "failed"}`,
      detail:
        "Expand the agent conversation in the Trace view to see what happened; or increase retries and run again.",
    };
  }

  if (error.includes("stuck: no ready nodes")) {
    return {
      title: "Workflow stuck: no runnable next step",
      detail:
        "Usually this means no edge condition matched. Check the condition expressions at the branch against the node outputs.",
    };
  }

  return { title: error.slice(0, 160) };
}
