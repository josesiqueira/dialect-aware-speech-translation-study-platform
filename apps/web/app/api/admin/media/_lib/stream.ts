// Streaming of a stored media file to an authenticated admin (spec 35, 36, 67, 135).
// The storage key never leaves the server, and there is no public URL: the
// browser only ever sees /api/admin/media/:id.
import "server-only";
import { Readable } from "node:stream";
import { AppError } from "@dialect/domain";
import type { ServiceContext } from "@dialect/research";

export type ByteRange = { start: number; end: number };

// Reads an HTTP Range header (RFC 9110, section 14) for a file of `sizeBytes`.
//   null             no range requested, or a header this server ignores (another
//                    unit, or several ranges): the whole file is sent with 200
//   "unsatisfiable"  the range cannot be served: 416
//   { start, end }   inclusive byte positions: 206
export function parseRangeHeader(header: string | null, sizeBytes: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return null;
  const spec = value.slice("bytes=".length).trim();
  if (spec.includes(",")) return null;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return "unsatisfiable";
  const [, startText = "", endText = ""] = match;
  if (startText === "" && endText === "") return "unsatisfiable";
  if (sizeBytes <= 0) return "unsatisfiable";

  if (startText === "") {
    // Suffix range: the last N bytes.
    const length = Number(endText);
    if (!Number.isSafeInteger(length) || length <= 0) return "unsatisfiable";
    return { start: Math.max(0, sizeBytes - length), end: sizeBytes - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= sizeBytes) return "unsatisfiable";
  if (endText === "") return { start, end: sizeBytes - 1 };
  const end = Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, sizeBytes - 1) };
}

export type StreamableAsset = { id: string; storageKey: string; mimeType: string };

export async function streamMedia(
  ctx: ServiceContext,
  request: Request,
  asset: StreamableAsset,
  options: { downloadName?: string } = {},
): Promise<Response> {
  // The size comes from storage, so a range is checked against the real file.
  const stat = await ctx.storage.stat(asset.storageKey);
  if (!stat) {
    throw new AppError("MEDIA_NOT_FOUND", "The file of this media record is not in storage.", {
      mediaAssetId: asset.id,
    });
  }
  const sizeBytes = stat.sizeBytes;

  const headers = new Headers({
    "Content-Type": asset.mimeType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": options.downloadName ? `attachment; filename="${options.downloadName}"` : "inline",
  });

  const range = parseRangeHeader(request.headers.get("range"), sizeBytes);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${sizeBytes}`);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Disposition");
    return new Response(
      JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "The requested byte range cannot be served." } }),
      { status: 416, headers },
    );
  }

  const body = await ctx.storage.get(asset.storageKey, range ? { range } : undefined);
  const stream = Readable.toWeb(body) as ReadableStream<Uint8Array>;
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${sizeBytes}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(stream, { status: 206, headers });
  }
  headers.set("Content-Length", String(sizeBytes));
  return new Response(stream, { status: 200, headers });
}
