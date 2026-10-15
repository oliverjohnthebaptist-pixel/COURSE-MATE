'use strict';

const BASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function configured() {
  return Boolean(BASE_URL && SERVICE_KEY);
}

function requireConfig() {
  if (!configured()) {
    throw new Error('Supabase server storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }
}

async function request(url, options = {}) {
  requireConfig();
  const response = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

function select(table, filters = {}) {
  const params = new URLSearchParams({ select: '*' });
  Object.entries(filters).forEach(([key, value]) => params.set(key, `eq.${value}`));
  return request(`/rest/v1/${table}?${params.toString()}`);
}

function upsert(table, rows, conflict) {
  if (!rows.length) return Promise.resolve([]);
  const params = conflict ? `?on_conflict=${encodeURIComponent(conflict)}` : '';
  return request(`/rest/v1/${table}${params}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(rows)
  });
}

function remove(table, filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => params.set(key, `eq.${value}`));
  return request(`/rest/v1/${table}?${params.toString()}`, { method: 'DELETE' });
}

function objectUrl(bucket, objectPath) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  return `/storage/v1/object/${bucket}/${encoded}`;
}

async function download(bucket, objectPath) {
  requireConfig();
  const response = await fetch(`${BASE_URL}${objectUrl(bucket, objectPath)}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase file download failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function upload(bucket, objectPath, bytes, contentType) {
  requireConfig();
  const response = await fetch(`${BASE_URL}${objectUrl(bucket, objectPath)}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: bytes
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase file upload failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function createSignedUpload(bucket, objectPath) {
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  const result = await request(`/storage/v1/object/upload/sign/${bucket}/${encodedPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' },
    body: JSON.stringify({})
  });
  if (!result || typeof result.token !== 'string' || !result.token) {
    throw new Error('Supabase did not return a signed upload token.');
  }
  return { token: result.token };
}

async function createSignedDownload(bucket, objectPath, expiresIn = 60) {
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  const result = await request(`/storage/v1/object/sign/${bucket}/${encodedPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn })
  });
  if (!result || typeof result.signedURL !== 'string' || !result.signedURL) {
    throw new Error('Supabase did not return a signed download URL.');
  }
  if (/^https:\/\//i.test(result.signedURL)) return result.signedURL;
  const suffix = result.signedURL.startsWith('/storage/v1/')
    ? result.signedURL
    : `/storage/v1${result.signedURL.startsWith('/') ? '' : '/'}${result.signedURL}`;
  return `${BASE_URL}${suffix}`;
}

async function removeObject(bucket, objectPath) {
  requireConfig();
  const response = await fetch(`${BASE_URL}${objectUrl(bucket, objectPath)}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase file delete failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

module.exports = { configured, select, upsert, remove, download, upload, createSignedUpload, createSignedDownload, removeObject };
