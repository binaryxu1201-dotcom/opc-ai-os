import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Environment } from "@opc/config";

export interface ExportStorage {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class S3ExportStorage implements ExportStorage {
  private readonly client: S3Client;
  public constructor(private readonly bucket: string, environment: Environment) {
    if (!environment.EXPORT_S3_ENDPOINT || !environment.EXPORT_S3_ACCESS_KEY_ID || !environment.EXPORT_S3_SECRET_ACCESS_KEY) throw new Error("Export S3 storage is not configured.");
    this.client = new S3Client({ endpoint: environment.EXPORT_S3_ENDPOINT, forcePathStyle: true, region: environment.EXPORT_S3_REGION, credentials: { accessKeyId: environment.EXPORT_S3_ACCESS_KEY_ID, secretAccessKey: environment.EXPORT_S3_SECRET_ACCESS_KEY } });
  }
  async put(key: string, content: Buffer): Promise<void> { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content, ContentType: "text/csv; charset=utf-8" })); }
  async get(key: string): Promise<Buffer> { const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); if (!output.Body) throw new Error("Export object has no body."); return Buffer.from(await output.Body.transformToByteArray()); }
  async remove(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}
