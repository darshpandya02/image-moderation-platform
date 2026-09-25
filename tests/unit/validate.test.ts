import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sanitizeImage } from "@/lib/images/sanitize";
import {
  assertDeclaredUpload,
  assertUploadable,
  MAX_UPLOAD_BYTES,
  sniffImageType,
  UploadRejectedError,
} from "@/lib/images/validate";
import { checkPassword, createSession, verifySession } from "@/lib/auth";

async function jpegWithExif() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam", Model: "Unit", Copyright: "gps-and-owner-data" } })
    .toBuffer();
}

describe("magic byte sniffing", () => {
  it("recognises JPEG, PNG and WebP by content", async () => {
    const base = sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } });
    expect(sniffImageType(await base.clone().jpeg().toBuffer())?.mime).toBe("image/jpeg");
    expect(sniffImageType(await base.clone().png().toBuffer())?.mime).toBe("image/png");
    expect(sniffImageType(await base.clone().webp().toBuffer())?.mime).toBe("image/webp");
  });

  it("rejects other formats regardless of claimed type", async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).gif().toBuffer();
    expect(sniffImageType(gif)).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(() => assertUploadable(Buffer.from("MZ\x90\x00 not an image"))).toThrow(UploadRejectedError);
  });

  it("enforces the 5 MB cap and rejects empty files", () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(() => assertUploadable(big)).toThrow(/exceeds/);
    expect(() => assertUploadable(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => assertDeclaredUpload(MAX_UPLOAD_BYTES + 1, "image/jpeg")).toThrow(/exceeds/);
    expect(() => assertDeclaredUpload(1000, "image/gif")).toThrow(/JPEG, PNG and WebP/);
    expect(() => assertDeclaredUpload(1000, "image/png")).not.toThrow();
  });
});

describe("sanitizeImage", () => {
  it("strips EXIF while keeping pixels", async () => {
    const input = await jpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await sanitizeImage(input);
    expect(out.hadMetadata).toBe(true);
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.data.includes(Buffer.from("gps-and-owner-data"))).toBe(false);
    expect([out.width, out.height]).toEqual([64, 48]);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies EXIF orientation before stripping it", async () => {
    const rotated = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#123" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await sanitizeImage(rotated);
    expect([out.width, out.height]).toEqual([20, 40]);
  });

  it("rejects files with valid magic bytes but a corrupt body", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    await expect(sanitizeImage(fake)).rejects.toMatchObject({ code: "undecodable" });
  });
});

describe("reviewer session", () => {
  it("accepts only the configured password", () => {
    process.env.REVIEWER_PASSWORD = "correct horse";
    expect(checkPassword("correct horse")).toBe(true);
    expect(checkPassword("correct hors")).toBe(false);
    expect(checkPassword(undefined)).toBe(false);
  });

  it("signs expiring session tokens and rejects tampering", () => {
    const now = Date.now();
    const token = createSession(now);
    expect(verifySession(token, now)).toBe(true);
    expect(verifySession(token, now + 9 * 3600 * 1000)).toBe(false);
    const [a, exp, sig] = token.split(".");
    expect(verifySession(`${a}.${Number(exp) + 1000}.${sig}`, now)).toBe(false);
    expect(verifySession("reviewer.1.abc", now)).toBe(false);
    expect(verifySession(undefined, now)).toBe(false);
  });
});
