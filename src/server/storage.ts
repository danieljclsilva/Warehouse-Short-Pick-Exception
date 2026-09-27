import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type StoredObject = { body: Uint8Array; contentType: string };
export type ObjectStorage = {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
};

let overrideStorage: ObjectStorage | null | undefined;
let configuredStorage: ObjectStorage | null | undefined;

function createS3Storage(): ObjectStorage | null {
  const bucket = process.env.STORAGE_BUCKET;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  const endpoint = process.env.STORAGE_ENDPOINT;
  const region = process.env.STORAGE_REGION ?? "auto";
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!object.Body) return null;
        return { body: new Uint8Array(await object.Body.transformToByteArray()), contentType: object.ContentType ?? "application/octet-stream" };
      } catch (error) {
        if (error && typeof error === "object" && "name" in error && (error.name === "NoSuchKey" || error.name === "NotFound")) return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export function getStorage(): ObjectStorage | null {
  if (overrideStorage !== undefined) return overrideStorage;
  if (configuredStorage === undefined) configuredStorage = createS3Storage();
  return configuredStorage;
}

/** Inject a fake object store in tests without configuring cloud credentials. */
export function setStorageForTests(storage: ObjectStorage | null | undefined) {
  overrideStorage = storage;
}

export function resetStorageConfigurationForTests() {
  overrideStorage = undefined;
  configuredStorage = undefined;
}

export function assertStorageConfigured(): ObjectStorage {
  const storage = getStorage();
  if (!storage) throw new Error("Persistent object storage is not configured. Set STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, and STORAGE_SECRET_ACCESS_KEY.");
  return storage;
}

export function isStorageConfigured() { return getStorage() !== null; }
