import { describe, expect, it } from "vitest";

import { groupArtifacts, publishedSlugs } from "../artifactOrigins.js";
import type { ArtifactInfo } from "../artifacts.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const C = "99999999-8888-7777-6666-555555555555";

const line = (content: unknown[]): string => JSON.stringify({ type: "x", message: { content } });
const call = (id: string, input: Record<string, unknown>) => line([{ type: "tool_use", id, name: "Artifact", input }]);
const result = (id: string, text: unknown) => line([{ type: "tool_result", tool_use_id: id, content: text }]);

describe("publishedSlugs", () => {
  it("takes the page a publish went to, and only from a publish's own result", () => {
    const transcript = [
      call("t1", { file_path: "a.html", icon: "chart" }),
      result("t1", `Published a.html at https://claude.ai/code/artifact/${A}`),
      call("t2", { action: "read", url: `https://claude.ai/code/artifact/${C}` }),
      result("t2", `content of https://claude.ai/code/artifact/${C}`),
      line([{ type: "text", text: `see https://claude.ai/code/artifact/${C}` }]),
      call("t3", { action: "publish", file_path: "b.html" }),
      result("t3", [{ type: "text", text: `Published b.html at https://claude.ai/code/artifact/${B.toUpperCase()}` }]),
      call("t4", { file_path: "a.html" }),
      result("t4", `Published a.html at https://claude.ai/code/artifact/${A}`),
    ].join("\n");
    expect(publishedSlugs(transcript)).toEqual([A, B]);
  });

  it("survives lines that are not JSON", () => {
    expect(publishedSlugs(`not json "name":"Artifact"\n${call("t", {})}\n${result("t", `at https://claude.ai/code/artifact/${A}`)}`)).toEqual([A]);
  });
});

const item = (slug: string, updatedAt: string): ArtifactInfo =>
  ({ slug, title: slug.slice(0, 4), description: "", icon: "", shared: false, updatedAt, url: "" });

describe("groupArtifacts", () => {
  const items = [item(A, "2026-10-29"), item(B, "2026-10-20"), item(C, "2026-10-10")];
  const origins = { [A]: [{ dir: "P", session: "s1" }], [B]: [{ dir: "Q", session: "s9" }, { dir: "P", session: "s2" }] };

  it("all: by the project each came from, the ones from no session last", () => {
    expect(groupArtifacts(items, origins, "all", { dir: null, sessions: [] }).map((g) => [g.key, g.items.map((i) => i.slug)]))
      .toEqual([["P", [A]], ["Q", [B]], ["", [C]]]);
  });

  it("project: that project's, by the session that published it", () => {
    expect(groupArtifacts(items, origins, "project", { dir: "P", sessions: [] }).map((g) => [g.key, g.items.map((i) => i.slug)]))
      .toEqual([["s1", [A]], ["s2", [B]]]);
    expect(groupArtifacts(items, origins, "project", { dir: null, sessions: [] })).toEqual([]);
  });

  it("session: the session's own, folded ids included, as one list", () => {
    expect(groupArtifacts(items, origins, "session", { dir: "P", sessions: ["s0", "s2"] }).map((g) => g.items.map((i) => i.slug)))
      .toEqual([[B]]);
  });
});
