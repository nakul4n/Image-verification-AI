/**
 * Minimal in-process async job queue with bounded concurrency.
 * Uploads return immediately with status PROCESSING; workers finish the
 * heavy image work (HEIC decode, hashing, blur scoring, S3 put) in the
 * background. Swap for BullMQ/SQS in a multi-instance deployment.
 */
class JobQueue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.running = 0;
    this.jobs = [];
  }

  push(job) {
    this.jobs.push(job);
    this.drain();
  }

  drain() {
    while (this.running < this.concurrency && this.jobs.length > 0) {
      const job = this.jobs.shift();
      this.running += 1;
      Promise.resolve()
        .then(job)
        .catch((err) => console.error('[queue] job failed:', err))
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }
}

module.exports = new JobQueue(Number(process.env.UPLOAD_CONCURRENCY) || 3);
