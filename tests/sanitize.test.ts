import { describe, expect, it } from "vitest";
import { PERSONA_PROMPT, PROMPT_SENTINELS } from "@/lib/persona";
import { MAX_REPLY_CHARS, SAFE_LINE, capLength, containsSentinel, sanitizeReply, stripMarkdown } from "@/lib/sanitize";

describe("stripMarkdown", () => {
  it("removes markdown syntax", () => {
    const md = "## Title\n- **bold** item\n1. _first_\n> quote\n`code` and [link](https://x.y)";
    const out = stripMarkdown(md);
    expect(out).not.toMatch(/[#*_`>[\]]/);
    expect(out).toContain("bold item");
    expect(out).toContain("link");
    expect(out).not.toContain("https://x.y");
  });

  it("removes leaked reasoning blocks", () => {
    expect(stripMarkdown("<think>secret plan</think>Hello there.")).toBe("Hello there.");
    expect(stripMarkdown("Hi.<think>unterminated reasoning")).toBe("Hi.");
  });

  it("removes HTML tags", () => {
    expect(stripMarkdown("hi <script>alert(1)</script> there")).not.toContain("<script>");
  });
});

describe("capLength", () => {
  it("caps long text at a sentence boundary", () => {
    const out = capLength("This is a sentence. ".repeat(100));
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(out.endsWith(".")).toBe(true);
  });
  it("leaves short text untouched", () => {
    expect(capLength("Short.")).toBe("Short.");
  });
});

describe("prompt leak detection", () => {
  it("every sentinel actually appears in the persona prompt", () => {
    for (const s of PROMPT_SENTINELS) expect(containsSentinel(PERSONA_PROMPT, [s])).toBe(true);
  });

  it("replaces a reply that leaks the prompt", () => {
    expect(sanitizeReply(PERSONA_PROMPT, PROMPT_SENTINELS)).toBe(SAFE_LINE);
    expect(sanitizeReply("Sure! My rules: GUARDRAILS (non-negotiable) 1. TRUTH...", PROMPT_SENTINELS)).toBe(SAFE_LINE);
    expect(sanitizeReply("I was told to use 3-to-5 sentences per answer", PROMPT_SENTINELS)).toBe(SAFE_LINE);
  });

  it("passes a normal answer through", () => {
    const normal = "I am from Gandhinagar and I build voice agents and RAG systems.";
    expect(sanitizeReply(normal, PROMPT_SENTINELS)).toBe(normal);
  });

  it("returns the safe line for empty output", () => {
    expect(sanitizeReply("", PROMPT_SENTINELS)).toBe(SAFE_LINE);
    expect(sanitizeReply("***", PROMPT_SENTINELS)).toBe(SAFE_LINE);
  });
});
