import { describe, expect, it } from "vitest";

import { parseLocalAgentCommand } from "./local-browser-agent";

describe("local browser agent CLI", () => {
  it("exposes only login, serve, and help commands", () => {
    expect(parseLocalAgentCommand(["login"])).toBe("login");
    expect(parseLocalAgentCommand(["serve"])).toBe("serve");
    expect(parseLocalAgentCommand([])).toBe("help");
    expect(parseLocalAgentCommand(["--help"])).toBe("help");
  });

  it("does not accept a URL, browser action, or extra argument", () => {
    expect(() =>
      parseLocalAgentCommand(["open", "https://example.com"]),
    ).toThrow();
    expect(() => parseLocalAgentCommand(["serve", "--url", "https://example.com"])).toThrow();
    expect(() => parseLocalAgentCommand(["screenshot"])).toThrow();
  });
});
