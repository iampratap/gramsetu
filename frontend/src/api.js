const TOKEN_KEY = "gramsetu_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body,
  });

  const isJson = (response.headers.get("content-type") || "").includes("json");
  const data = isJson ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    if (response.status === 401 && !options.quiet && !path.startsWith("/api/auth/login")) {
      setToken(null);
      if (window.location.pathname !== "/login") window.location.assign("/login");
    }
    throw new ApiError(data.error || "Request failed", response.status);
  }
  return data;
}

export function audioUrl(id, download = false) {
  const token = getToken();
  const kind = download ? "download" : "stream";
  return `/api/audio/${id}/${kind}?access_token=${encodeURIComponent(token || "")}`;
}
