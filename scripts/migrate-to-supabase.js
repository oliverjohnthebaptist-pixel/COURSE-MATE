#!/usr/bin/env node
'use strict';

if (!process.argv.includes('--dry-run')) require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SB_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const DATA_DIR = path.resolve(process.env.COURSEMATE_STORAGE_DIR || ROOT, 'data');
const UPLOAD_DIR = path.resolve(process.env.COURSEMATE_STORAGE_DIR || ROOT, 'uploads');
const RECEIPT_DIR = path.join(DATA_DIR, 'payment-evidence');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readJson(name, fallback) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

function readMergedSummaries() {
  const current = readJson('summaries.json', {});
  const legacyFile = path.join(ROOT, 'summaries.json');
  if (!fs.existsSync(legacyFile)) return current;
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${legacyFile}: ${error.message}`);
  }
  return { ...legacy, ...current };
}

function readMergedQuizResults() {
  const current = readJson('quiz_results.json', []);
  const legacyFile = path.join(ROOT, 'quiz_results.json');
  if (!fs.existsSync(legacyFile)) return current;
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${legacyFile}: ${error.message}`);
  }
  if (!Array.isArray(current) || !Array.isArray(legacy)) {
    throw new Error('Quiz results must be JSON arrays.');
  }
  const merged = new Map(legacy.map(item => [String(item.id), item]));
  current.forEach(item => merged.set(String(item.id), item));
  return [...merged.values()];
}

function requireUuid(value, description) {
  if (!UUID.test(String(value || ''))) {
    throw new Error(`${description} has no valid Supabase auth user UUID: ${String(value)}. Create or map that user before importing.`);
  }
  return value;
}

function safeObjectPath(userId, recordId, filename) {
  const base = path.basename(String(filename || 'file')).replace(/[^\w.-]+/g, '_');
  const record = String(recordId).replace(/[^\w.-]+/g, '_');
  return `${userId}/${record}/${base}`;
}

async function api(pathname, init = {}) {
  const response = await fetch(`${SB_URL}${pathname}`, {
    ...init,
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      ...(init.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${init.method || 'GET'} ${pathname} failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : null;
}

async function upsert(table, rows, conflict) {
  if (!rows.length) return;
  await api(`/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
}

async function upload(bucket, objectPath, file) {
  const bytes = fs.readFileSync(file);
  const extension = path.extname(file).toLowerCase();
  const contentType = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  }[extension] || 'application/octet-stream';
  const response = await fetch(`${SB_URL}/storage/v1/object/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: bytes
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload ${file} failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

function resolveStoredFile(filePath, fallbackName, allowedRoot) {
  const candidates = [
    filePath && path.resolve(filePath),
    fallbackName && path.resolve(allowedRoot, path.basename(fallbackName))
  ].filter(Boolean);
  const file = candidates.find(candidate => {
    const relative = path.relative(allowedRoot, candidate);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
  if (!file) throw new Error(`Could not find a local file under ${allowedRoot} (record references ${filePath || fallbackName || 'no filename'}).`);
  const actual = fs.realpathSync(file);
  const realRoot = fs.realpathSync(allowedRoot);
  const relative = path.relative(realRoot, actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to import a file outside ${allowedRoot}: ${file}.`);
  }
  return actual;
}

function loadSources() {
  const users = readJson('users.json', {});
  const materials = readJson('materials.json', []);
  const histories = readJson('tma_history.json', []);
  const payments = readJson('payment_submissions.json', []);
  const quizzes = readMergedQuizResults();
  const summaries = readMergedSummaries();
  const ownerByMaterial = new Map();
  const materialFiles = new Map();
  const receiptFiles = new Map();

  for (const material of materials) {
    const userId = requireUuid(material.user_id, `Material ${material.id}`);
    if (!material.id) throw new Error('A material is missing its id.');
    const localFile = resolveStoredFile(material.file_path, material.file_name, UPLOAD_DIR);
    materialFiles.set(String(material.id), localFile);
    ownerByMaterial.set(String(material.id), userId);
  }

  Object.keys(users).forEach(id => requireUuid(id, 'User state'));

  for (const item of histories) {
    const userId = requireUuid(item.user_id, `TMA history ${item.material_id}`);
    if (ownerByMaterial.get(String(item.material_id)) !== userId) {
      throw new Error(`TMA history references missing material ${item.material_id}; import its material first.`);
    }
  }

  for (const quiz of quizzes) {
    const userId = requireUuid(quiz.user_id, `Quiz result ${quiz.id}`);
    if (ownerByMaterial.get(String(quiz.material_id)) !== userId) {
      throw new Error(`Quiz result references missing material ${quiz.material_id}; import its material first.`);
    }
    if (!quiz.id) throw new Error('A quiz result is missing its id.');
  }

  Object.keys(summaries).forEach(materialId => {
    const userId = ownerByMaterial.get(String(materialId));
    if (!userId) throw new Error(`Summary references missing material ${materialId}; import its material first.`);
  });

  for (const payment of payments) {
    const userId = requireUuid(payment.user_id, `Payment submission ${payment.id}`);
    const paymentId = payment.id;
    if (!paymentId) throw new Error('A payment submission is missing its id.');
    if (payment.receipt) receiptFiles.set(String(paymentId), resolveStoredFile(payment.receipt, payment.receipt, RECEIPT_DIR));
  }

  return { users, materials, histories, payments, quizzes, summaries, ownerByMaterial, materialFiles, receiptFiles };
}

async function main() {
  const sources = loadSources();
  const { users, materials, histories, payments, quizzes, summaries, ownerByMaterial, materialFiles, receiptFiles } = sources;
  const importedFiles = materialFiles.size + receiptFiles.size;
  if (process.argv.includes('--dry-run')) {
    console.log(`Dry run passed: ${Object.keys(users).length} user states, ${materials.length} materials, ${histories.length} TMA histories, ${quizzes.length} quiz results, ${Object.keys(summaries).length} summaries (including legacy-only records), ${payments.length} payment submissions, ${importedFiles} files validated. No Supabase changes made.`);
    return;
  }
  if (!SB_URL || !SB_SERVICE) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the local environment before running this import.');

  for (const material of materials) {
    const userId = material.user_id;
    const localFile = materialFiles.get(String(material.id));
    const storagePath = safeObjectPath(userId, material.id, material.file_name || path.basename(localFile));
    await upload('coursemate-files', storagePath, localFile);
    const metadata = { ...material, file_path: null, storage_path: storagePath };
    await upsert('cm_materials', [{
      id: String(material.id), user_id: userId, storage_path: storagePath,
      metadata, created_at: material.created_at || new Date().toISOString()
    }], 'id');
  }

  const userRows = Object.entries(users).map(([id, state]) => ({
    user_id: id,
    email: String(state.email || ''),
    state,
    updated_at: new Date().toISOString()
  }));
  await upsert('cm_user_state', userRows, 'user_id');

  for (const item of histories) {
    const userId = item.user_id;
    await upsert('cm_tma_history', [{
      user_id: userId, material_id: String(item.material_id), payload: item,
      updated_at: item.updated_at || new Date().toISOString()
    }], 'user_id,material_id');
  }

  for (const quiz of quizzes) {
    const userId = quiz.user_id;
    await upsert('cm_quiz_results', [{
      id: String(quiz.id), user_id: userId, material_id: String(quiz.material_id),
      payload: quiz, created_at: quiz.at ? new Date(quiz.at).toISOString() : new Date().toISOString()
    }], 'id');
  }

  const summaryRows = Object.entries(summaries).map(([materialId, payload]) => {
    const userId = ownerByMaterial.get(String(materialId));
    return { user_id: userId, material_id: String(materialId), payload, updated_at: new Date().toISOString() };
  });
  await upsert('cm_summaries', summaryRows, 'user_id,material_id');

  for (const payment of payments) {
    const userId = payment.user_id;
    const paymentId = payment.id;
    let receiptPath = null;
    if (payment.receipt) {
      const localReceipt = receiptFiles.get(String(paymentId));
      receiptPath = safeObjectPath(userId, paymentId, payment.receipt);
      await upload('coursemate-receipts', receiptPath, localReceipt);
    }
    await upsert('cm_payment_submissions', [{
      id: paymentId, user_id: userId, receipt_path: receiptPath,
      payload: { ...payment, receipt: null, receipt_path: receiptPath },
      created_at: payment.created_at || new Date().toISOString()
    }], 'id');
  }

  console.log(`Supabase import complete: ${userRows.length} user states, ${materials.length} materials, ${histories.length} TMA histories, ${quizzes.length} quiz results, ${summaryRows.length} summaries (including legacy-only records), ${payments.length} payment submissions, ${importedFiles} files.`);
}

main().catch(error => {
  console.error(`[migration] ${error.message}`);
  process.exitCode = 1;
});
