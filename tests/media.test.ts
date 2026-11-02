import { describe, expect, it } from "vitest";
import { detectContainer, parseRange, sanitizeOriginalName } from "@/lib/server/media";
import { fakeMp4 } from "./helpers";

describe("parseRange", () => {
  it("handles standard, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("returns null for absent, multi-range or malformed headers", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
  });
  it("flags unsatisfiable ranges", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=50-10", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

describe("detectContainer", () => {
  it("recognises MP4, MOV and WebM/MKV from bytes, not names", () => {
    expect(detectContainer(fakeMp4(64))?.extension).toBe("mp4");
    const mov = fakeMp4(64);
    mov.write("qt  ", 8, "latin1");
    expect(detectContainer(mov)?.mimeType).toBe("video/quicktime");
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("....webm....")]);
    expect(detectContainer(webm)?.extension).toBe("webm");
    const mkv = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("....matroska")]);
    expect(detectContainer(mkv)?.extension).toBe("mkv");
  });
  it("rejects non-video content", () => {
    expect(detectContainer(Buffer.from("%PDF-1.7 hello world"))).toBeNull();
    const m4a = fakeMp4(64);
    m4a.write("M4A ", 8, "latin1");
    expect(detectContainer(m4a)).toBeNull();
  });
});

describe("sanitizeOriginalName", () => {
  it("strips paths and control characters", () => {
    expect(sanitizeOriginalName(encodeURIComponent("../../etc/passwd"))).toBe("passwd");
    expect(sanitizeOriginalName(encodeURIComponent("C:\\clips\\a\u0000b.mp4"))).toBe("ab.mp4");
    expect(sanitizeOriginalName(null)).toBe("Untitled video");
    expect(sanitizeOriginalName("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
