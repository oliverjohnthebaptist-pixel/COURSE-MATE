'use strict';

const crypto = require('crypto');
const store = require('./supabase-store');

const handlers = new Map();
let runAsUser = null;
let running = false;
let retryAt = 0;
let workerState = 'starting';

function configure(options) {
  runAsUser = options.runAsUser;
}

function register(type, handler) {
  handlers.set(type, handler);
}

async function enqueue(userId, type, payload) {
  const id = crypto.randomUUID();
  await store.insert('cm_ai_jobs', [{
    id,
    user_id: userId,
    type,
    payload,
    status: 'queued',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]);
  return id;
}

async function eventsFor(userId, id, after = 0) {
  const rows = await store.select('cm_ai_job_events', {
    job_id: id,
    user_id: userId,
    seq: { gt: Math.max(0, Number(after) || 0) }
  });
  return rows.sort((a, b) => a.seq - b.seq);
}

async function getJob(userId, id) {
  const rows = await store.select('cm_ai_jobs', { user_id: userId, id });
  return rows[0] || null;
}

async function updateJob(id, values) {
  const updated = await store.update('cm_ai_jobs', {
    ...values,
    updated_at: new Date().toISOString()
  }, { id });
  if (!updated.length) throw new Error(`AI job ${id} was not updated.`);
}

async function run(job) {
  const handler = handlers.get(job.type);
  if (!handler) throw new Error(`No worker is registered for AI job type "${job.type}".`);
  let batch = [];
  let flushPromise = Promise.resolve();
  const flush = () => {
    if (!batch.length) return flushPromise;
    const events = batch;
    batch = [];
    flushPromise = flushPromise.catch(() => {}).then(() => store.insert('cm_ai_job_events', [{
        job_id: job.id,
        user_id: job.user_id,
        events
      }])).catch(error => {
        batch = events.concat(batch);
        throw error;
      });
    return flushPromise;
  };
  const timer = setInterval(() => {
    flush().catch(error => console.error(`[ai-jobs] event persistence failed for ${job.id}`, error));
  }, 500);
  const lease = setInterval(() => {
    updateJob(job.id, { claimed_at: new Date().toISOString() })
      .catch(error => console.error(`[ai-jobs] lease renewal failed for ${job.id}`, error));
  }, 60 * 1000);
  const emit = event => {
    batch.push(event);
    if (batch.length >= 20) flush().catch(error => console.error(`[ai-jobs] event persistence failed for ${job.id}`, error));
  };

  try {
    await runAsUser(job.user_id, async () => {
      await handler(job.payload || {}, emit);
    });
    await flush();
    await flushPromise;
    await updateJob(job.id, { status: 'completed', completed_at: new Date().toISOString(), error: null });
  } catch (error) {
    console.error(`[ai-jobs] job ${job.id} (${job.type}) failed`, error);
    emit({ type: 'error', error: error.message || 'This task could not be completed. Please try again.' });
    await flush();
    await flushPromise;
    await updateJob(job.id, {
      status: 'failed',
      error: String(error.message || error).slice(0, 1000),
      completed_at: new Date().toISOString()
    });
  } finally {
    clearInterval(timer);
    clearInterval(lease);
    await flush();
  }
}

async function workOnce() {
  const claimed = await store.rpc('claim_cm_ai_job');
  const job = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!job) {
    workerState = 'idle';
    return false;
  }
  workerState = `working:${job.type}`;
  await run(job);
  return true;
}

async function workLoop() {
  if (running) return;
  running = true;
  try {
    while (true) {
      if (Date.now() < retryAt) {
        workerState = 'retrying';
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      try {
        const found = await workOnce();
        if (!found) await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        workerState = 'error';
        retryAt = Date.now() + 30000;
        console.error('[ai-jobs] worker could not claim or process a job; retrying in 30 seconds', error);
      }
    }
  } finally {
    running = false;
  }
}

function start() {
  if (!runAsUser) throw new Error('AI jobs require a configured user-context loader.');
  workerState = 'starting';
  workLoop().catch(error => {
    workerState = 'error';
    console.error('[ai-jobs] worker stopped unexpectedly', error);
  });
}

function status() {
  return workerState;
}

module.exports = { configure, register, enqueue, getJob, eventsFor, start, status };
