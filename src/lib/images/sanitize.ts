import { createHash } from "node:crypto";
import sharp, { type Metadata, type OutputInfo } from "sharp";
import { assertUploadable, UploadRejectedError, type ImageKind } from "./validate";

export const MAX_PIXELS = 40_000_000;

export type SanitizedImage = {
  data: Buffer;
  kind: ImageKind;
  width: number;
  height: number;
  sha256: string;
  bytesOriginal: number;
  hadMetadata: boolean;
};

/**
 * Re-encodes the image so no EXIF, XMP, IPTC or ICC-embedded metadata
 * survives (sharp drops metadata unless asked to keep it). The EXIF
 * orientation is applied to the pixels first so photos stay upright.
 */
export async function sanitizeImage(input: Uint8Array): Promise<SanitizedImage> {
  const kind = assertUploadable(input);
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

  let meta: Metadata;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new UploadRejectedError("undecodable", "image could not be decoded");
  }
  if (!meta.width || !meta.height) {
    throw new UploadRejectedError("undecodable", "image has no dimensions");
  }
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new UploadRejectedError("too_many_pixels", "image has too many pixels", 413);
  }
  const hadMetadata = Boolean(meta.exif || meta.xmp || meta.iptc);

  let pipeline = sharp(buf, { limitInputPixels: MAX_PIXELS, animated: false }).rotate();
  if (kind.mime === "image/jpeg") pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
  else if (kind.mime === "image/png") pipeline = pipeline.png({ compressionLevel: 9 });
  else pipeline = pipeline.webp({ quality: 90 });

  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch {
    throw new UploadRejectedError("undecodable", "image could not be decoded");
  }

  return {
    data: out.data,
    kind,
    width: out.info.width,
    height: out.info.height,
    sha256: createHash("sha256").update(out.data).digest("hex"),
    bytesOriginal: input.byteLength,
    hadMetadata,
  };
}
