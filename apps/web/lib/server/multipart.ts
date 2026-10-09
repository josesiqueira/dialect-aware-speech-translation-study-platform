// A small multipart/form-data reader for the upload routes (RFC 7578).
//
// Why not request.formData(): the platform parser reads the whole body into
// memory and then copies every file part into a Blob, and the route needs a
// Buffer, which is a further copy (file.arrayBuffer()). A recording of up to
// 100 MB was therefore held two to three times. This reader works on the one
// buffer that readLimitedBody() filled: a file part is a view (subarray) of
// that buffer, so the recording is in memory exactly once. No dependency is
// added: the parser handles what browsers send for FormData (one boundary, CRLF
// line ends, Content-Disposition with name and filename, Content-Type) and
// refuses everything else.
import "server-only";
import { AppError } from "@dialect/domain";

export type MultipartFile = {
  // A view of the request body buffer. Not a copy.
  data: Buffer;
  // Content type the browser declared for the part ("" when none).
  type: string;
  filename: string | null;
};

export type MultipartBody = {
  // Text parts by name (the first part of a name wins).
  fields: Map<string, string>;
  // File parts by name (the first part of a name wins).
  files: Map<string, MultipartFile>;
};

const MAX_PARTS = 16;
const MAX_PART_HEADER_BYTES = 8 * 1024;
const MAX_FIELD_BYTES = 256 * 1024;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

function malformed(): AppError {
  return new AppError("VALIDATION_ERROR", "The upload could not be read. Please try again.");
}

// The boundary parameter of a multipart/form-data content type, or null.
export function multipartBoundary(contentType: string): string | null {
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return null;
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function parameter(header: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, "i").exec(header);
  if (!match) return null;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? null);
}

export function parseMultipart(body: Buffer, contentType: string): MultipartBody {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new AppError("VALIDATION_ERROR", "The upload must be sent as multipart/form-data.");
  const delimiter = Buffer.from(`--${boundary}`);
  const result: MultipartBody = { fields: new Map(), files: new Map() };

  let position = body.indexOf(delimiter);
  if (position === -1) throw malformed();
  for (let parts = 0; ; parts += 1) {
    position += delimiter.length;
    // "--" after the delimiter ends the body.
    if (body[position] === 0x2d && body[position + 1] === 0x2d) return result;
    if (parts >= MAX_PARTS) throw malformed();
    if (body.indexOf(CRLF, position) !== position) throw malformed();
    const headerStart = position + CRLF.length;
    const headerEnd = body.indexOf(HEADER_END, headerStart);
    if (headerEnd === -1 || headerEnd - headerStart > MAX_PART_HEADER_BYTES) throw malformed();
    const contentStart = headerEnd + HEADER_END.length;
    // The content ends before the CRLF that precedes the next delimiter.
    const next = body.indexOf(Buffer.concat([CRLF, delimiter]), contentStart);
    if (next === -1) throw malformed();

    let disposition = "";
    let type = "";
    for (const line of body.toString("utf8", headerStart, headerEnd).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const headerName = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (headerName === "content-disposition") disposition = value;
      else if (headerName === "content-type") type = value;
    }
    if (!disposition.toLowerCase().startsWith("form-data")) throw malformed();
    const name = parameter(disposition, "name");
    if (name === null || name === "") throw malformed();
    const filename = parameter(disposition, "filename");
    const content = body.subarray(contentStart, next);
    if (filename !== null) {
      if (!result.files.has(name)) result.files.set(name, { data: content, type, filename });
    } else {
      if (content.length > MAX_FIELD_BYTES) throw malformed();
      if (!result.fields.has(name)) result.fields.set(name, content.toString("utf8"));
    }
    position = next + CRLF.length;
  }
}
