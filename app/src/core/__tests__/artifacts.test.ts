import { describe, expect, it } from "vitest";

import { artifactUrl, failureFor, isArtifactUrl, parseArtifacts } from "../artifacts.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseArtifacts", () => {
  it("reads the endpoint's frames, newest first, and links each to its page", () => {
    const items = parseArtifacts({ frames: [
      { slug: A, title: "Older", description: "d", icon_key: "chart", rel: "mine", updatedAt: "2026-10-01T00:00:00Z" },
      { slug: B, title: " Newer ", icon: "Chat", rel: "shared", updatedAt: "2026-10-20T00:00:00Z" },
    ] });
    expect(items?.map((item) => item.title)).toEqual(["Newer", "Older"]);
    expect(items?.[0]).toMatchObject({ icon: "chat", shared: true, url: artifactUrl(B) });
    expect(items?.[1]).toMatchObject({ icon: "chart", shared: false, description: "d" });
  });

  it("drops rows it cannot read, and names an untitled one", () => {
    const items = parseArtifacts({ frames: [{ slug: "not-a-slug", title: "x" }, { slug: A }, null] });
    expect(items).toEqual([expect.objectContaining({ slug: A, title: "Untitled" })]);
  });

  it("is null when the answer is not a list of frames — the route has changed", () => {
    expect(parseArtifacts({ error: "nope" })).toBeNull();
    expect(parseArtifacts(null)).toBeNull();
  });
});

describe("failureFor", () => {
  it("reads a JSON 401/403 as the login, anything else as a changed route", () => {
    expect(failureFor(401, "application/json")).toBe("login");
    expect(failureFor(403, "application/json; charset=utf-8")).toBe("login");
    expect(failureFor(403, "text/html; charset=UTF-8")).toBe("changed");
    expect(failureFor(404, "application/json")).toBe("changed");
  });
});

describe("isArtifactUrl", () => {
  it("opens only an Artifact page on claude.ai", () => {
    expect(isArtifactUrl(artifactUrl(A))).toBe(true);
    expect(isArtifactUrl("https://claude.ai/code/artifact/../settings")).toBe(false);
    expect(isArtifactUrl(`https://evil.example/code/artifact/${A}`)).toBe(false);
  });
});
