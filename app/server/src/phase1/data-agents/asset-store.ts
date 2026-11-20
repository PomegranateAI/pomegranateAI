import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/** Private originals only. Public access always goes through application authorization. */
export interface AssetStore {
  readonly backend: string;
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalAssetStore implements AssetStore {
  readonly backend = 'local';
  constructor(private root: string) {}
  private filename(key: string): string {
    const root = path.resolve(this.root);
    const filename = path.resolve(root, key);
    if (!filename.startsWith(root + path.sep)) throw new Error('invalid_asset_key');
    return filename;
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const filename = this.filename(key);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  read(key: string): Promise<Buffer> {
    return fs.readFile(this.filename(key));
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.filename(key), { force: true });
  }
}

export class S3AssetStore implements AssetStore {
  readonly backend = 's3';
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}
  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }));
  }
  async read(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('asset_missing');
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function assetStores(root: string): { current: AssetStore; stores: Record<string, AssetStore> } {
  const local = new LocalAssetStore(root);
  const stores: Record<string, AssetStore> = { local };
  if (process.env.POMEGRANATE_ASSET_BUCKET) {
    stores.s3 = new S3AssetStore(
      new S3Client({
        region: process.env.POMEGRANATE_ASSET_REGION ?? 'us-east-1',
        endpoint: process.env.POMEGRANATE_ASSET_ENDPOINT,
        forcePathStyle: process.env.POMEGRANATE_ASSET_PATH_STYLE === '1',
        // Uses the standard AWS credential chain (also works with Spaces keys).
      }),
      process.env.POMEGRANATE_ASSET_BUCKET,
    );
  }
  return { current: stores.s3 ?? local, stores };
}
