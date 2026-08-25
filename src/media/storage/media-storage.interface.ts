/**
 * MediaStorageProvider — the small abstraction `MediaService` depends on,
 * rather than coupling directly to `@aws-sdk/client-s3` (master plan
 * §11's service/repository separation, applied one layer further down for
 * the one genuinely external dependency this phase adds). Exactly the
 * three operations P8 actually needs (master plan §21 P8's own scope
 * list) — no presigned-upload method, no multipart method, no delete
 * method: none of those exist in this phase (base64-bridge V1 only,
 * archive-only lifecycle, no hard delete anywhere in `MediaService`).
 *
 * `R2StorageProvider` (the only real implementation) is real in every
 * environment — including tests, which run it against a local MinIO
 * endpoint (docker-compose.yml) rather than a stub, so "the storage
 * adapter behaves correctly" is actually proven, not assumed. See that
 * class's own doc comment for the full reasoning.
 */
export interface PutObjectResult {
  readonly url: string;
}

export interface MediaStorageProvider {
  /** Uploads `body` to `key`, returning the durable public URL. */
  putObject(key: string, body: Buffer, contentType: string): Promise<PutObjectResult>;

  /** Reads an object back — used only by `media-worker` (master plan §12) to inspect bytes for dimension extraction. Never called from the synchronous upload/list/archive request path. */
  getObject(key: string): Promise<Buffer>;
}

export const MEDIA_STORAGE_PROVIDER = Symbol('MEDIA_STORAGE_PROVIDER');
