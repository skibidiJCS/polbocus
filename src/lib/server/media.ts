import "server-only";

export interface DetectedContainer {
  mimeType: string;
  extension: string;
  label: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("latin1");

// Leading QuickTime atoms that appear before (or instead of) an ftyp box in older .mov files.
const quickTimeAtoms = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/**
 * Identifies the container from the file's first bytes. The client's MIME type and
 * filename are never trusted. Returns null for anything we do not accept.
 */
export function detectContainer(head: Uint8Array): DetectedContainer | null {
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "qt  ") return { mimeType: "video/quicktime", extension: "mov", label: "QuickTime MOV" };
    if (brand === "M4V " || brand === "M4VH" || brand === "M4VP") return { mimeType: "video/mp4", extension: "m4v", label: "M4V" };
    // Audio-only and still-image ISO BMFF brands are not videos.
    if (["M4A ", "M4B ", "M4P ", "heic", "heix", "mif1", "msf1", "avif"].includes(brand)) return null;
    return { mimeType: "video/mp4", extension: "mp4", label: "MP4" };
  }
  if (head.length >= 8 && quickTimeAtoms.has(ascii(head, 4, 8))) {
    return { mimeType: "video/quicktime", extension: "mov", label: "QuickTime MOV" };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const isWebm = Buffer.from(head).includes("webm", 0, "latin1");
    return isWebm
      ? { mimeType: "video/webm", extension: "webm", label: "WebM" }
      : { mimeType: "video/x-matroska", extension: "mkv", label: "Matroska MKV" };
  }
  return null;
}

export const ACCEPTED_FORMATS_LABEL = "MP4, MOV, M4V, WebM, or MKV";

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range "bytes=" header against a file size.
 * Returns null when no usable Range header is present (serve the whole file),
 * or "unsatisfiable" for ranges that must produce 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Multi-range and malformed headers are ignored; the full file is a valid response.
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "unsatisfiable";
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/** Keeps only a safe display name; it is metadata, never a filesystem path. */
export function sanitizeOriginalName(raw: string | null): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw header value when it is not valid percent-encoding.
  }
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length > 200) name = name.slice(0, 200);
  return name || "Untitled video";
}

export const STORAGE_NAME_PATTERN = /^[0-9a-f-]{36}\.(mp4|mov|m4v|webm|mkv)$/;
