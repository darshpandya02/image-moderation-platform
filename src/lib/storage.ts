import { del, get, put } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from "@/lib/images/validate";

/**
 * Object storage. Uploads go straight from the browser to a private Vercel
 * Blob store using a short-lived token scoped to one pathname and capped at
 * 5 MB, which keeps large bodies off the function (whose request limit is
 * 4.5 MB). Nothing in the store is public; approved images are streamed
 * through /api/images/[id]/file.
 */
export interface BlobStore {
  issueUploadToken(pathname: string): Promise<string>;
  read(pathname: string, maxBytes: number): Promise<Uint8Array | null>;
  write(pathname: string, data: Buffer, contentType: string): Promise<void>;
  stream(pathname: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null>;
  remove(pathname: string): Promise<void>;
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      // Return one byte past the cap so callers can report "too large".
      const over = new Uint8Array(maxBytes + 1);
      return over;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export const vercelBlobStore: BlobStore = {
  async issueUploadToken(pathname) {
    return generateClientTokenFromReadWriteToken({
      pathname,
      maximumSizeInBytes: MAX_UPLOAD_BYTES,
      allowedContentTypes: [...ALLOWED_MIME],
      validUntil: Date.now() + 10 * 60 * 1000,
      allowOverwrite: false,
    });
  },
  async read(pathname, maxBytes) {
    const res = await get(pathname, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return readCapped(res.stream, maxBytes);
  },
  async write(pathname, data, contentType) {
    await put(pathname, data, { access: "private", contentType, allowOverwrite: true });
  },
  async stream(pathname) {
    const res = await get(pathname, { access: "private" });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return { body: res.stream, contentType: res.blob.contentType ?? "application/octet-stream" };
  },
  async remove(pathname) {
    await del(pathname);
  },
};

/** In-memory store for tests and local runs without a Blob token. */
export function memoryBlobStore(): BlobStore & { objects: Map<string, { data: Buffer; contentType: string }> } {
  const objects = new Map<string, { data: Buffer; contentType: string }>();
  return {
    objects,
    async issueUploadToken(pathname) {
      return `memory-token:${pathname}`;
    },
    async read(pathname, maxBytes) {
      const o = objects.get(pathname);
      if (!o) return null;
      return o.data.byteLength > maxBytes ? new Uint8Array(maxBytes + 1) : new Uint8Array(o.data);
    },
    async write(pathname, data, contentType) {
      objects.set(pathname, { data: Buffer.from(data), contentType });
    },
    async stream(pathname) {
      const o = objects.get(pathname);
      if (!o) return null;
      return { body: new Blob([new Uint8Array(o.data)]).stream(), contentType: o.contentType };
    },
    async remove(pathname) {
      objects.delete(pathname);
    },
  };
}

let override: BlobStore | null = null;
export function getBlobStore(): BlobStore {
  return override ?? vercelBlobStore;
}
export function setBlobStore(s: BlobStore | null) {
  override = s;
}
