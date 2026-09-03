const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

/**
 * Database abstraction layer.
 * Attempts PostgreSQL connection via PrismaClient; gracefully falls back
 * to an in-memory repository when PostgreSQL is not configured/running locally.
 */
class DatabaseService {
  constructor() {
    this.inMemoryRecords = new Map();
    this.usePrisma = true;
    this.prisma = new PrismaClient({
      log: ['error'],
    });

    // Test connection proactively
    this.prisma.$connect()
      .then(() => {
        console.log('✓ PostgreSQL connected via Prisma');
      })
      .catch((err) => {
        console.warn('⚠ PostgreSQL connection not available. Falling back to in-memory store for zero-setup local execution.');
        this.usePrisma = false;
      });
  }

  async create(data) {
    if (this.usePrisma) {
      try {
        return await this.prisma.imageUpload.create({ data });
      } catch (err) {
        console.warn('⚠ Prisma query failed, switching to in-memory fallback:', err.message);
        this.usePrisma = false;
      }
    }

    const id = crypto.randomUUID();
    const record = {
      id,
      originalName: data.originalName,
      mimeType: data.mimeType,
      s3Key: data.s3Key || null,
      fileSize: data.fileSize,
      width: data.width || null,
      height: data.height || null,
      status: data.status || 'PROCESSING',
      rejectionReason: data.rejectionReason || null,
      imageHash: data.imageHash || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.inMemoryRecords.set(id, record);
    return record;
  }

  async update(id, data) {
    if (this.usePrisma) {
      try {
        return await this.prisma.imageUpload.update({
          where: { id },
          data,
        });
      } catch (err) {
        console.warn('⚠ Prisma update failed, switching to in-memory fallback:', err.message);
        this.usePrisma = false;
      }
    }

    const existing = this.inMemoryRecords.get(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...data,
      updatedAt: new Date(),
    };
    this.inMemoryRecords.set(id, updated);
    return updated;
  }

  async findRecentAcceptedHashes(limit = 500) {
    if (this.usePrisma) {
      try {
        return await this.prisma.imageUpload.findMany({
          where: { status: 'ACCEPTED', imageHash: { not: null } },
          select: { id: true, imageHash: true },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
      } catch (err) {
        console.warn('⚠ Prisma findMany failed, falling back to in-memory store');
        this.usePrisma = false;
      }
    }

    return Array.from(this.inMemoryRecords.values())
      .filter((r) => r.status === 'ACCEPTED' && r.imageHash)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ id: r.id, imageHash: r.imageHash }));
  }

  async findUnique(id) {
    if (this.usePrisma) {
      try {
        return await this.prisma.imageUpload.findUnique({ where: { id } });
      } catch {
        this.usePrisma = false;
      }
    }
    return this.inMemoryRecords.get(id) || null;
  }

  async findMany({ where = {}, take = 50, skip = 0 }) {
    if (this.usePrisma) {
      try {
        const [rows, total] = await this.prisma.$transaction([
          this.prisma.imageUpload.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
          this.prisma.imageUpload.count({ where }),
        ]);
        return { rows, total };
      } catch {
        this.usePrisma = false;
      }
    }

    let records = Array.from(this.inMemoryRecords.values());
    if (where.status) {
      records = records.filter((r) => r.status === where.status);
    }
    const total = records.length;
    const rows = records
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(skip, skip + take);
    return { rows, total };
  }

  async delete(id) {
    if (this.usePrisma) {
      try {
        await this.prisma.imageUpload.delete({ where: { id } });
        return true;
      } catch {
        this.usePrisma = false;
      }
    }
    return this.inMemoryRecords.delete(id);
  }
}

module.exports = new DatabaseService();
