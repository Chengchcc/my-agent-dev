interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  url?: string;
}

const ARTIFACT_URL = /(artifacts:\/\/[^\s<>()]+)/;

function splitArtifactLinks(value: string): MdastNode[] {
  const parts = value.split(ARTIFACT_URL);
  const nodes: MdastNode[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (ARTIFACT_URL.test(part)) {
      nodes.push({
        type: "link",
        url: part,
        children: [{ type: "text", value: part }],
      });
    } else {
      nodes.push({ type: "text", value: part });
    }
  }
  return nodes;
}

/** Convert bare `artifacts://` URLs in markdown text nodes into links so
 *  the Markdown `a` renderer can substitute the artifact card. Skips code
 *  spans/fences automatically — only `text` nodes are transformed. */
export function remarkArtifactUrls() {
  return (tree: MdastNode) => {
    function walk(node: MdastNode) {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value && valueContainsArtifact(child.value)) {
          return splitArtifactLinks(child.value);
        }
        walk(child);
        return [child];
      });
    }
    walk(tree);
  };
}

function valueContainsArtifact(value: string): boolean {
  return value.includes("artifacts://");
}
