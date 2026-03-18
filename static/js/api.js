/**
 * api.js — Thin fetch wrapper for the Relay backend.
 * Exposes a global `api` object with .get(), .post(), .put(), .delete() methods.
 * All methods throw an Error with the backend's detail message on non-2xx responses.
 */
const api = (() => {
  const BASE = '';

  async function request(method, path, body, params) {
    let url = BASE + path;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += '?' + qs;
    }

    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.detail || `HTTP ${res.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  }

  return {
    get:    (path, params) => request('GET', path, undefined, params),
    post:   (path, body)   => request('POST', path, body),
    put:    (path, body)   => request('PUT', path, body),
    delete: (path, params) => request('DELETE', path, undefined, params),
  };
})();