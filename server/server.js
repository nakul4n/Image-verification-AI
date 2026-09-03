const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const imagePipeline = require('./services/imagePipeline');
const storage = require('./services/storage');
const queue = require('./services/queue');

const prisma = new PrismaClient();
const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// Serve locally-stored objects when S3 is not configured
app.use('/files/uploads', express.static(path.join(__dirname, 'uploads', 'uploads')));

// Secure file handling: memory storage (no temp paths on disk), hard size cap,
// and a MIME allowlist enforced before the body is buffered.
const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/x-mac-heic'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.includes(String(file.mimetype).toLowerCase())) {
      return cb(Object.assign(new Error('INVALID_FORMAT'), { code: 'INVALID_FORMAT' }));
    }
    return cb(null, true);
  },
});

function readOverrides(req) {
  return {
    blur: req.headers['x-override-blur'] === 'true',
    smallFace: req.headers['x-override-small-face'] === 'true',
    multiFace: req.headers['x-override-multi-face'] === 'true',
    duplicate: req.headers['x-override-duplicate'] === 'true',
  };
}

function serialize(record) {
  return { ...record, url: storage.publicUrl(record.s3Key) };
}

/** Heavy work: validate, persist to object storage, finalize DB row. */
async function processUpload(recordId, file, overrides) {
  // Indexed, projected query — only the hash column, capped window.
  const existingHashes = await prisma.imageUpload.findMany({
    where: { status: 'ACCEPTED', imageHash: { not: null } },
    select: { id: true, imageHash: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const result = await imagePipeline.processAndValidate(
    file.buffer,
    file.mimetype,
    overrides,
    existingHashes
  );

  let s3Key = null;
  if (result.isValid) {
    s3Key = await storage.put(result.buffer, file.originalname, result.mime);
  }

  return prisma.imageUpload.update({
    where: { id: recordId },
    data: {
      status: result.isValid ? 'ACCEPTED' : 'REJECTED',
      rejectionReason: result.isValid ? null : result.reason,
      width: result.metadata?.width ?? null,
      height: result.metadata?.height ?? null,
      imageHash: result.imageHash ?? null,
      s3Key,
    },
  });
}

// CREATE
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file resource uploaded.' });

    const record = await prisma.imageUpload.create({
      data: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        status: 'PROCESSING',
      },
    });

    const overrides = readOverrides(req);

    // Async mode: return 202 immediately, client polls GET /api/upload/:id
    if (req.headers['prefer'] === 'respond-async') {
      queue.push(() =>
        processUpload(record.id, req.file, overrides).catch((err) =>
          prisma.imageUpload.update({
            where: { id: record.id },
            data: { status: 'FAILED', rejectionReason: String(err.message).slice(0, 200) },
          })
        )
      );
      return res.status(202).json({ success: true, data: serialize(record) });
    }

    const finalRecord = await new Promise((resolve, reject) => {
      queue.push(() => processUpload(record.id, req.file, overrides).then(resolve, reject));
    });

    return res
      .status(finalRecord.status === 'ACCEPTED' ? 201 : 422)
      .json({ success: finalRecord.status === 'ACCEPTED', data: serialize(finalRecord) });
  } catch (error) {
    if (error.code === 'INVALID_FORMAT' || error.code === 'LIMIT_FILE_SIZE') {
      return res.status(422).json({
        success: false,
        data: { status: 'REJECTED', rejectionReason: 'INVALID_FORMAT' },
      });
    }
    console.error(error);
    return res.status(500).json({ error: 'Internal processing loop pipeline failure.' });
  }
});

// READ (paginated + filterable, backed by indexes)
app.get('/api/uploads', async (req, res) => {
  const take = Math.min(Number(req.query.limit) || 50, 200);
  const skip = Math.max(Number(req.query.offset) || 0, 0);
  const status = req.query.status;
  const where = status ? { status: String(status).toUpperCase() } : {};

  const [rows, total] = await prisma.$transaction([
    prisma.imageUpload.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.imageUpload.count({ where }),
  ]);
  return res.json({ success: true, data: rows.map(serialize), total, limit: take, offset: skip });
});

app.get('/api/upload/:id', async (req, res) => {
  const record = await prisma.imageUpload.findUnique({ where: { id: req.params.id } });
  if (!record) return res.status(404).json({ error: 'Not found' });
  return res.json({ success: true, data: serialize(record) });
});

// DELETE (removes DB row and the stored object)
app.delete('/api/upload/:id', async (req, res) => {
  const record = await prisma.imageUpload.findUnique({ where: { id: req.params.id } });
  if (!record) return res.status(404).json({ error: 'Not found' });
  await storage.remove(record.s3Key);
  await prisma.imageUpload.delete({ where: { id: record.id } });
  return res.status(200).json({ success: true });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Express API Service executing on port ${PORT}`));
