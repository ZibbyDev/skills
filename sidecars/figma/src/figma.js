import { fetch } from 'undici';

// PAT-proxy model: no OAuth, no token store. Each MCP request carries the user's
// Figma Personal Access Token in a header; we forward it to the Figma REST API.
// (Figma authenticates PATs via the `X-Figma-Token` header.)
const API_ROOT = (process.env.FIGMA_API_ROOT || 'https://api.figma.com').replace(/\/$/, '');

export async function figmaRequest(pat, method, p, { query, body } = {}) {
  if (!pat) {
    const e = new Error('missing Figma token');
    e.code = 'NO_TOKEN';
    throw e;
  }
  let url = `${API_ROOT}${p}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'X-Figma-Token': pat,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`Figma ${method} ${p} failed: ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export { API_ROOT };
