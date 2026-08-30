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
      title: `节点 ${m[1]} 依赖的产物不存在`,
      detail: `运行前必须先提供 ${m[2]}。可在 Artifacts 页面上传，或运行时在对应输入框选择正确地址。`,
    };
  }

  const a = /workflow (\S+) input artifact (\S+) does not exist: (\S+)/.exec(error);
  if (a) {
    return {
      title: `输入产物 ${a[2]} 不存在`,
      detail: `本次运行提供的 ${a[3]} 在产物库中找不到。请先上传，或检查地址拼写。`,
    };
  }

  const o = /node (\S+) missing required output artifact: (\S+)/.exec(error);
  if (o) {
    return {
      title: `节点 ${o[1]} 没有产出声明的产物`,
      detail: `该节点承诺产出 ${o[2]} 但执行后不存在。Agent 需要调用 artifact_upload 上传产物后，流程才能继续。`,
    };
  }

  const s = /node (\S+) output invalid: (.+)/.exec(error);
  if (s) {
    return {
      title: `节点 ${s[1]} 的输出格式不符`,
      detail: `${s[2]}。可在节点属性里放宽 output 声明，或调整提示词让 Agent 按要求输出后重试。`,
    };
  }

  const sc = /script failed \(exit \d+\): (.+)/s.exec(error);
  if (sc) {
    const failed = nodeRuns.find((r) => r.status === "failed");
    return {
      title: `脚本节点 ${failed?.nodeId ?? "?"} 运行出错`,
      detail: sc[1]!.split("\n")[0]!.slice(0, 200),
    };
  }

  const ag = /agent run (\S+) ended (failed|aborted|timeout|commit_failed)/.exec(error);
  if (ag) {
    const failed = nodeRuns.find((r) => r.status === "failed");
    return {
      title: `Agent 节点 ${failed?.nodeId ?? "?"} 执行${ag[2] === "timeout" ? "超时" : "失败"}`,
      detail: "可在 Trace 中展开该 Agent 的对话查看过程；或增加重试次数后重新运行。",
    };
  }

  if (error.includes("stuck: no ready nodes")) {
    return {
      title: "流程卡住：没有可执行的下一步",
      detail: "通常是边条件都没命中。检查分叉处的条件表达式与节点输出是否匹配。",
    };
  }

  return { title: error.slice(0, 160) };
}
