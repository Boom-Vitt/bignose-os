// Same-origin API boundary for the local structure viewer.

export function isLocalApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return false;
  }
  try {
    const url = new URL(path, 'http://local.invalid');
    return url.origin === 'http://local.invalid'
      && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
  } catch {
    return false;
  }
}

export function fetchLocalApi(path, options = {}, fetchImpl = fetch) {
  if (!isLocalApiPath(path)) {
    return Promise.reject(new TypeError('relative local API path required'));
  }
  return fetchImpl(path, options);
}
