import { describe, expect, it } from "vitest";

import { parseRead } from "../deskIcons.js";

describe("parseRead", () => {
  it("reads the helper's header and one icon per line", () => {
    const out = "auto 0 95 102\r\nFAAf+/= 27 2\r\nagA6 -1053 410\r\n";
    expect(parseRead(out)).toEqual({
      autoArrange: false,
      spacing: { x: 95, y: 102 },
      icons: [{ id: "FAAf+/=", x: 27, y: 2 }, { id: "agA6", x: -1053, y: 410 }],
    });
  });

  it("knows auto-arrange is on", () => {
    expect(parseRead("auto 1 95 102\n")?.autoArrange).toBe(true);
  });

  it("refuses anything else", () => {
    expect(parseRead("Unspecified error")).toBeNull();
  });
});
