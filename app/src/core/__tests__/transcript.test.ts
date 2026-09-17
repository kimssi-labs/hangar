import { describe, expect, it } from "vitest";

import { factsFrom } from "../transcript.js";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A session started by /clear, in the shape Claude Code actually writes it. */
const CLEARED = [
  line({ type: "last-prompt", sessionId: "s" }),
  line({ type: "user", message: { content: "<local-command-caveat>Caveat: …</local-command-caveat>" } }),
  line({ type: "user", message: { content: "<command-name>/clear</command-name>\n<command-args></command-args>" } }),
  line({
    type: "user",
    message: { content: "apiFuncGetStatus, apiFuncGetSegmentStatus 차이는 뭐야?" },
    origin: { kind: "human" },
    promptSource: "typed",
  }),
  line({ type: "ai-title", aiTitle: "apiFunc 상태 조회 비교" }),
  line({ type: "assistant", message: { content: "…" } }),
  line({ type: "user", message: [{ type: "tool_result", content: "…" }] }),
  line({ type: "ai-title", aiTitle: "apiFuncGetStatus vs apiFuncGetSegmentStatus 차이" }),
].join("");

/** What Claude Code leaves behind when the conversation ends up in another file. */
const STUB = [
  line({ type: "ai-title", aiTitle: "VSCode 마켓플레이스 릴리즈 및 자동 배포 설정" }),
  line({ type: "agent-name", agentName: "VSCode 마켓플레이스 릴리즈 및 자동 배포 설정" }),
].join("");

describe("factsFrom", () => {
  it("takes the newest ai-title, because Claude Code keeps improving it", () => {
    expect(factsFrom(CLEARED, "", true).aiTitle).toBe("apiFuncGetStatus vs apiFuncGetSegmentStatus 차이");
  });

  it("finds the first prompt a person typed, past the caveat and the /clear echo", () => {
    // The two entries before it are also type "user"; only `origin.kind` tells them apart.
    expect(factsFrom(CLEARED, "", true).firstPrompt)
      .toBe("apiFuncGetStatus, apiFuncGetSegmentStatus 차이는 뭐야?");
  });

  it("shows only the first line of a prompt, which is all a row can hold", () => {
    const many = line({ type: "user", message: { content: " 첫 줄 \n둘째 줄" }, origin: { kind: "human" } });
    expect(factsFrom(many, "", true).firstPrompt).toBe("첫 줄");
  });

  it("does not mistake a tool result for something a person said", () => {
    const only = line({ type: "user", message: [{ type: "tool_result", content: "x" }], origin: { kind: "human" } });
    const facts = factsFrom(only, "", true);
    expect(facts.firstPrompt).toBeNull();
    expect(facts.conversation).toBe(true);          // still a turn, just not a typed one
  });

  it("reports a title-only stub as having no conversation", () => {
    const facts = factsFrom(STUB, "", true);
    expect(facts.conversation).toBe(false);
    expect(facts.aiTitle).toBe("VSCode 마켓플레이스 릴리즈 및 자동 배포 설정");
  });

  it("never calls a file too big to have been read whole a stub", () => {
    // The head window can start with anything; a long session must not be hidden on that evidence.
    expect(factsFrom(STUB, "", false).conversation).toBe(true);
  });

  it("finds an ai-title that only appears in the tail window", () => {
    const tail = line({ type: "ai-title", aiTitle: "훨씬 뒤에 붙은 제목" });
    expect(factsFrom(CLEARED, tail, false).aiTitle).toBe("훨씬 뒤에 붙은 제목");
  });

  it("survives the half lines a byte window cuts", () => {
    const cut = `type":"user","message":{"content":"잘린 줄"}}\n${CLEARED}{"type":"ai-tit`;
    expect(factsFrom(cut, "", true).aiTitle).toBe("apiFuncGetStatus vs apiFuncGetSegmentStatus 차이");
  });

  it("has nothing to say about an empty file", () => {
    expect(factsFrom("", "", true)).toEqual({ aiTitle: null, firstPrompt: null, conversation: false, startedByClear: false, carriedTitle: null });
  });
});

describe("the name a transcript is handed", () => {
  const line = (entry: Record<string, unknown>): string => `${JSON.stringify(entry)}
`;

  it("is read when it arrives before anyone has spoken — that is a conversation that moved here", () => {
    // Measured: Claude Code opens the new transcript with the old session's name as its first lines.
    const head = line({ type: "ai-title", aiTitle: "WMX3_ENGINE CreateDevice 오류 268" })
      + line({ type: "agent-name", agentName: "WMX3_ENGINE CreateDevice 오류 268" })
      + line({ type: "mode", mode: "normal" })
      + line({ type: "user", origin: { kind: "human" }, message: { content: "이어서 봐줘" } });
    expect(factsFrom(head, "", true).carriedTitle).toBe("WMX3_ENGINE CreateDevice 오류 268");
    expect(factsFrom(head, "", true).firstPrompt).toBe("이어서 봐줘");
  });

  it("reads the custom title the same way, and prefers the last name before the talking starts", () => {
    const head = line({ type: "custom-title", customTitle: "번역기" })
      + line({ type: "agent-name", agentName: "번역기" })
      + line({ type: "user", origin: { kind: "human" }, message: { content: "안녕" } });
    expect(factsFrom(head, "", true).carriedTitle).toBe("번역기");
  });

  it("is null for a title the session earned later, which is written after the conversation", () => {
    const head = line({ type: "user", origin: { kind: "human" }, message: { content: "첫 질문" } })
      + line({ type: "assistant", message: { content: "답" } })
      + line({ type: "ai-title", aiTitle: "스스로 붙인 이름" });
    const facts = factsFrom(head, "", true);
    expect(facts.carriedTitle).toBeNull();
    expect(facts.aiTitle).toBe("스스로 붙인 이름");
  });
});

describe("startedByClear", () => {
  it("is true for a transcript that opens with the /clear echo, before the first prompt", () => {
    expect(factsFrom(CLEARED, "", true).startedByClear).toBe(true);
  });

  it("is false for a fresh session, for a stub, and for a /clear typed later in the conversation", () => {
    const fresh = [
      line({ type: "user", message: { content: "첫 질문" }, origin: { kind: "human" } }),
      line({ type: "assistant", message: { content: "…" } }),
    ].join("");
    expect(factsFrom(fresh, "", true).startedByClear).toBe(false);
    expect(factsFrom(STUB, "", true).startedByClear).toBe(false);
    const later = fresh + line({ type: "user", message: { content: "<command-name>/clear</command-name>" } });
    expect(factsFrom(later, "", true).startedByClear).toBe(false);
  });
});
