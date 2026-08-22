const USER_AGENT = "ZoteroInstantCite/0.4 (mailto:sorin.hostiuc@umfcd.ro)";

function getDefaultTimeout(): number {
  // Read from preferences if available, otherwise fallback to 15s
  try {
    if (typeof Zotero !== "undefined" && Zotero.Prefs) {
      const secs = Zotero.Prefs.get("InstantCite.searchTimeout");
      if (typeof secs === "number" && secs >= 1 && secs <= 30) return secs * 1000;
    }
  } catch { /* ignore */ }
  return 15000;
}

export async function fetchJSON<T>(url: string, timeoutMs = getDefaultTimeout()): Promise<T> {
  const text = await httpGet(url, timeoutMs);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`JSON parse failed for ${url.slice(0, 100)}: ${e}`);
  }
}

export async function fetchXML(url: string, timeoutMs = getDefaultTimeout()): Promise<Document> {
  const text = await httpGet(url, timeoutMs);
  const parser = new DOMParser();
  return parser.parseFromString(text, "text/xml");
}

async function httpGet(url: string, timeoutMs: number): Promise<string> {
  // Use Zotero.HTTP.request when available (handles proxies, certs, redirects natively)
  if (typeof Zotero !== "undefined" && Zotero.HTTP?.request) {
    try {
      const resp = await Zotero.HTTP.request("GET", url, {
        timeout: timeoutMs,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/xml, */*",
        },
        responseType: "text",
      });
      if (resp.status >= 200 && resp.status < 300) {
        return resp.responseText;
      }
      throw new Error(formatHTTPError(resp.status, resp.statusText, resp.responseText));
    } catch (e: any) {
      const sanitized = sanitizeHTTPError(e);
      if (typeof Zotero !== "undefined") {
        Zotero.log("[InstantCite] Zotero.HTTP.request failed for " + url.slice(0, 80) + ": " + sanitized.message);
      }
      throw sanitized;
    }
  }

  // Fallback to XMLHttpRequest (test environment or if Zotero.HTTP unavailable)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = timeoutMs;
    try { xhr.setRequestHeader("User-Agent", USER_AGENT); } catch (_) { /* forbidden in some contexts */ }
    xhr.setRequestHeader("Accept", "application/json, text/xml, */*");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        reject(new Error(formatHTTPError(xhr.status, xhr.statusText, xhr.responseText)));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Request timeout"));
    xhr.send();
  });
}

function formatHTTPError(status: number, statusText = "", body = ""): string {
  if (isCloudflareChallenge(body)) {
    return `HTTP ${status}: blocked by Cloudflare challenge`;
  }
  const detail = stripHTML(body).replace(/\s+/g, " ").trim();
  const suffix = detail ? `: ${detail.slice(0, 240)}` : "";
  return `HTTP ${status}: ${statusText || "request failed"}${suffix}`;
}

function sanitizeHTTPError(err: any): Error {
  const message = String(err?.message ?? err);
  if (isCloudflareChallenge(message)) {
    const status = message.match(/status code\s+(\d+)|HTTP\s+(\d+)/i);
    const code = status?.[1] || status?.[2] || "403";
    return new Error(`HTTP ${code}: blocked by Cloudflare challenge`);
  }
  const cleaned = stripHTML(message).replace(/\s+/g, " ").trim();
  return new Error(cleaned.length > 300 ? cleaned.slice(0, 300) + "..." : cleaned);
}

function isCloudflareChallenge(text: string): boolean {
  return /Just a moment|Enable JavaScript and cookies|cf_chl|challenge-platform|Cloudflare/i.test(text);
}

function stripHTML(text: string): string {
  return text.replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

// Keep this export for test compatibility
export async function fetchWithTimeout(
  url: string,
  _options: RequestInit = {},
  timeoutMs = getDefaultTimeout(),
): Promise<Response> {
  const text = await httpGet(url, timeoutMs);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: new Headers(),
  } as Response;
}
