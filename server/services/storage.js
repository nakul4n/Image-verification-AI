const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

/**
 * Object storage abstraction.
 * Uses Amazon S3 when AWS credentials + S3_BUCKET are configured, otherwise
 * falls back to a local ./uploads directory so the service runs with zero setup.
 */
class StorageService {
  constructor() {
    this.bucket = process.env.S3_BUCKET;
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.localDir = path.join(__dirname, '..', 'uploads');
    this.useS3 = Boolean(
      this.bucket &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY
    );
    if (this.useS3) {
      // Lazy require so the dependency is optional for local runs
      const { S3Client } = require('@aws-sdk/client-s3');
      const clientConfig = { region: this.region };
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        clientConfig.credentials = {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        };
      }
      this.client = new S3Client(clientConfig);
    }
  }

  buildKey(originalName) {
    const safe = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
    return `uploads/${crypto.randomBytes(12).toString('hex')}-${safe}`;
  }

  async put(buffer, originalName, contentType) {
    const key = this.buildKey(originalName);

    if (this.useS3) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        })
      );
      return key;
    }

    await fs.mkdir(path.join(this.localDir, 'uploads'), { recursive: true });
    await fs.writeFile(path.join(this.localDir, key), buffer);
    return key;
  }

  async remove(key) {
    if (!key) return;
    if (this.useS3) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    await fs.rm(path.join(this.localDir, key), { force: true });
  }

  publicUrl(key) {
    if (!key) return null;
    if (this.useS3) return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
    return `/files/${key}`;
  }
}

module.exports = new StorageService();
