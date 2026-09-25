export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageKind = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" };

export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

export class UploadRejectedError extends Error {
  constructor(
    readonly code: "too_large" | "empty" | "unsupported_type" | "undecodable" | "too_many_pixels",
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

/**
 * Identifies the file by its leading bytes, never by the name or the
 * client-supplied Content-Type.
 */
export function sniffImageType(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= png.length && png.every((b, i) => buf[i] === b)) {
    return { mime: "image/png", ext: "png" };
  }
  // RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export function assertUploadable(buf: Uint8Array): ImageKind {
  if (buf.length === 0) throw new UploadRejectedError("empty", "file is empty");
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError("too_large", `file exceeds ${MAX_UPLOAD_BYTES} bytes`, 413);
  }
  const kind = sniffImageType(buf);
  if (!kind) {
    throw new UploadRejectedError("unsupported_type", "only JPEG, PNG and WebP images are accepted", 415);
  }
  return kind;
}

/** Validates the size a client declares before it is issued an upload token. */
export function assertDeclaredUpload(size: unknown, contentType: unknown): void {
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    throw new UploadRejectedError("empty", "size must be a positive integer");
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError("too_large", `file exceeds ${MAX_UPLOAD_BYTES} bytes`, 413);
  }
  if (typeof contentType !== "string" || !(ALLOWED_MIME as readonly string[]).includes(contentType)) {
    throw new UploadRejectedError("unsupported_type", "only JPEG, PNG and WebP images are accepted", 415);
  }
}
