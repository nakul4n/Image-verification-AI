const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const isDummy = (v) => !v || v.includes('your_') || v.includes('...');

/**
 * Object storage abstraction.
 * Uses Amazon S3 when valid AWS credentials + S3_BUCKET are configured, otherwise
 * falls back to a local ./uploads directory so the service runs with zero setup.
 */
class StorageService {
  constructor() {
    this.bucket = process.env.S3_BUCKET;
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.localDir = path.join(__dirname, '..', 'uploads');

    const hasRealCredentials =
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      !isDummy(process.env.AWS_ACCESS_KEY_ID) &&
      !isDummy(process.env.AWS_SECRET_ACCESS_KEY);

    this.useS3 = Boolean(this.bucket && hasRealCredentials);

    if (this.useS3) {
      try {
        const { S3Client } = require('@aws-sdk/client-s3');
        this.client = new S3Client({
          region: this.region,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        });
      } catch (err) {
        console.warn('⚠ Could not initialize S3 client, falling back to local disk:', err.message);
        this.useS3 = false;
      }
    }
  }

  buildKey(originalName) {
    const safe = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
    return `uploads/${crypto.randomBytes(12).toString('hex')}-${safe}`;
  }

  async put(buffer, originalName, contentType) {
    const key = this.buildKey(originalName);

    if (this.useS3 && this.client) {
      try {
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
      } catch (err) {
        console.warn('⚠ S3 upload failed, persisting to local disk storage:', err.message);
      }
    }

    // Local disk persistence fallback
    await fs.mkdir(path.join(this.localDir, 'uploads'), { recursive: true });
    await fs.writeFile(path.join(this.localDir, key), buffer);
    return key;
  }

  async remove(key) {
    if (!key) return;
    if (this.useS3 && this.client) {
      try {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        return;
      } catch (err) {
        console.warn('⚠ S3 delete failed:', err.message);
      }
    }
    try {
      await fs.rm(path.join(this.localDir, key), { force: true });
    } catch {}
  }

  publicUrl(key) {
    if (!key) return null;
    if (this.useS3) return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
    return `/files/${key}`;
  }
}

module.exports = new StorageService();
