import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeProfilePhoto, parseBoundedMultipartFormData } from "../src/server/profile-photos";
import { configurationPatchSchema, normalizeConfigurationValues } from "../src/server/configuration";
import { getStorage, resetStorageConfigurationForTests, setStorageForTests, type ObjectStorage } from "../src/server/storage";

describe("persistent storage adapter", () => {
  afterEach(() => resetStorageConfigurationForTests());

  it("routes object writes and reads through an injected object store", async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string }>();
    const storage: ObjectStorage = {
      async put(key, body, contentType) { objects.set(key, { body, contentType }); },
      async get(key) { return objects.get(key) ?? null; },
      async delete(key) { objects.delete(key); },
    };
    setStorageForTests(storage);
    const adapter = getStorage();
    expect(adapter).toBe(storage);
    await adapter!.put("test/item.pdf", new Uint8Array([1, 2]), "application/pdf");
    expect(await adapter!.get("test/item.pdf")).toEqual({ body: new Uint8Array([1, 2]), contentType: "application/pdf" });
  });
});

describe("profile photo normalization", () => {
  it("uses the versioned photo upload limit and validates its configured bounds", () => {
    expect(normalizeConfigurationValues({}).PROFILE_PHOTO_MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
    expect(configurationPatchSchema.safeParse({ expectedVersion: 1, values: { PROFILE_PHOTO_MAX_UPLOAD_BYTES: 1024 * 1024 } }).success).toBe(true);
    expect(configurationPatchSchema.safeParse({ expectedVersion: 1, values: { PROFILE_PHOTO_MAX_UPLOAD_BYTES: 1 } }).success).toBe(false);
  });

  it("re-encodes a square JPEG no larger than 512px", async () => {
    const png = await sharp({ create: { width: 900, height: 400, channels: 3, background: "#3f6" } }).png().toBuffer();
    const result = await normalizeProfilePhoto(png);
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects malformed image data", async () => {
    await expect(normalizeProfilePhoto(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
  });

  it("rejects over-limit multipart bodies without trusting content-length", async () => {
    const body = new Uint8Array(64 * 1024 + 1);
    const request = new Request("http://localhost/api/profile/photo", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test-boundary" },
      body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(parseBoundedMultipartFormData(request, 0)).rejects.toMatchObject({ code: "INVALID_INPUT", status: 413 });
  });
});
