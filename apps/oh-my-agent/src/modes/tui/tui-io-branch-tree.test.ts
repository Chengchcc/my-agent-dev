import { describe, expect, test } from "bun:test";
import type { SessionBranchNode } from "../../core/session/session-file.js";
import { layoutBranchTree } from "./tui-io.js";

function node(id: string, parentId: string | null, role = "assistant"): SessionBranchNode {
  return { id, parentId, role, text: id, depth: 0 };
}

/** Strip colors/roles: just the prefix per row, in tree order. */
function prefixes(rows: ReturnType<typeof layoutBranchTree>): string[] {
  return rows.map((r) => r.prefix);
}

describe("layoutBranchTree (git-graph lanes)", () => {
  test("linear chain stays flat — no indent per message", () => {
    const rows = layoutBranchTree([
      node("u1", null, "user"),
      node("a1", "u1"),
      node("u2", "a1", "user"),
      node("a2", "u2"),
    ]);
    expect(prefixes(rows)).toEqual(["", "", "", ""]);
  });

  test("fork indents children with connectors, last child gets └─", () => {
    // a1 branches into b1 and c1
    const rows = layoutBranchTree([
      node("u1", null, "user"),
      node("a1", "u1"),
      node("b1", "a1"),
      node("b2", "b1"),
      node("c1", "a1"),
      node("c2", "c1"),
    ]);
    expect(rows.map((r) => r.node.id)).toEqual(["u1", "a1", "b1", "b2", "c1", "c2"]);
    const p = prefixes(rows);
    expect(p[2]).toBe("├─ ");
    expect(p[3]).toBe("│     "); // sibling rail below the b-branch
    expect(p[4]).toBe("└─ ");
  });

  test("second fork level nests one more lane with rails", () => {
    // a1 forks into c1 and b1; b1's chain forks again at b2 into d1/d2
    const rows = layoutBranchTree([
      node("u1", null, "user"),
      node("a1", "u1"),
      node("c1", "a1"),
      node("b1", "a1"),
      node("b2", "b1"),
      node("d1", "b2"),
      node("d2", "b2"),
    ]);
    const p = prefixes(rows);
    // b1 is the LAST child of a1 → no rail below it; b2's fork nests at col 2
    expect(p[4]).toBe("      ");
    expect(p[5]).toBe("      ├─ ");
    expect(p[6]).toBe("      └─ ");
  });

  test("multiple roots render flat at column 0 (pi virtual-root rule)", () => {
    const rows = layoutBranchTree([node("a", null), node("b", null)]);
    expect(prefixes(rows)).toEqual(["", ""]);
  });
});
