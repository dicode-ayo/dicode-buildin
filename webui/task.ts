// webui/task.ts — Dashboard SPA and REST API gateway.
//
// This daemon task registers "GET /*" with the dicode HTTP gateway and handles:
//   - Serving the dashboard SPA shell (inline HTML with embedded JS app)
//   - WebSocket live log/event streaming (/ws)
//   - REST API passthrough to the daemon via dicode.* shim calls
//   - Session auth (passphrase check via KV store)
//   - AI chat SSE streaming (/api/tasks/:id/ai/stream)
//
// Auth model:
//   - POST /api/auth/login  → check passphrase (stored in KV), issue session token (cookie)
//   - POST /api/auth/refresh → no-op / always 204 (trusted-device refresh handled by daemon)
//   - POST /api/auth/logout  → clear session cookie
//   - All other /api/* and /ws routes require a valid session cookie or X-API-Key header
//   - GET /  → serves the SPA shell (no auth gate; the SPA itself shows the auth overlay)
//
// Session tokens are stored in KV: "session:<token>" = expiry ISO timestamp.
// Passphrase is stored in KV: "auth:passphrase" = hashed or plain value.
//
// NOTE: SW-based notifications are intentionally omitted (handled by the `notify` task).

// ── Shim globals injected by dicode runtime ───────────────────────────────────
// log, params, kv, dicode, http  (see pkg/runtime/deno/sdk/shim.js)
declare const log: {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
};
declare const kv: {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Record<string, unknown>>;
};
declare const dicode: {
  run_task(taskID: string, params?: Record<string, string>): Promise<unknown>;
  list_tasks(): Promise<TaskSummary[]>;
  get_runs(taskID: string, opts?: { limit?: number }): Promise<RunSummary[]>;
  get_config(section: string): Promise<unknown>;
};
declare const http: {
  register(pattern: string, handler: HttpHandler): void;
};

// ── Types ─────────────────────────────────────────────────────────────────────

type HttpHandler = (req: InboundRequest) => Promise<OutboundResponse> | OutboundResponse;

interface InboundRequest {
  requestID: string;
  httpMethod: string;
  path: string;
  query?: string;
  reqHeaders?: Record<string, string>;
  reqBody?: Uint8Array;
}

interface OutboundResponse {
  status: number;
  respHeaders?: Record<string, string>;
  respBody?: Uint8Array | string;
}

interface TaskSummary {
  id: string;
  name: string;
  description?: string;
  trigger: string;
  lastStatus: string;
  lastRunID: string;
  lastRunAt: string;
}

interface RunSummary {
  id: string;
  taskID: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function text(body: string, status = 200, extra?: Record<string, string>): OutboundResponse {
  return {
    status,
    respHeaders: { "content-type": "text/plain; charset=utf-8", ...extra },
    respBody: enc.encode(body),
  };
}

function json(data: unknown, status = 200): OutboundResponse {
  return {
    status,
    respHeaders: { "content-type": "application/json; charset=utf-8" },
    respBody: enc.encode(JSON.stringify(data)),
  };
}

function jsonErr(message: string, status: number): OutboundResponse {
  return json({ error: message }, status);
}

function html(body: string, status = 200): OutboundResponse {
  return {
    status,
    respHeaders: { "content-type": "text/html; charset=utf-8" },
    respBody: enc.encode(body),
  };
}

function sse(body: string): OutboundResponse {
  return {
    status: 200,
    respHeaders: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
    respBody: enc.encode(body),
  };
}

function getHeader(req: InboundRequest, name: string): string {
  if (!req.reqHeaders) return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(req.reqHeaders)) {
    if (k.toLowerCase() === lower) return v;
  }
  return "";
}

function getCookies(req: InboundRequest): Record<string, string> {
  const raw = getHeader(req, "cookie");
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(";").map((s) => {
      const [k, ...v] = s.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    }),
  );
}

function parseQuery(query?: string): URLSearchParams {
  return new URLSearchParams(query ?? "");
}

function bodyText(req: InboundRequest): string {
  if (!req.reqBody || req.reqBody.length === 0) return "";
  return dec.decode(req.reqBody);
}

function parseJSON<T = unknown>(req: InboundRequest): T | null {
  try {
    return JSON.parse(bodyText(req)) as T;
  } catch {
    return null;
  }
}

// ── Session management ─────────────────────────────────────────────────────────
// Sessions are stored in KV as "session:<token>" = ISO expiry.
// Token is a 32-byte hex string.

const SESSION_COOKIE = "dicode_sess";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

async function issueSession(): Promise<string> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await kv.set(`session:${token}`, expiry);
  return token;
}

async function validateSession(token: string): Promise<boolean> {
  if (!token) return false;
  const expiry = await kv.get(`session:${token}`);
  if (typeof expiry !== "string") return false;
  return new Date(expiry) > new Date();
}

async function revokeSession(token: string): Promise<void> {
  await kv.delete(`session:${token}`);
}

function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

async function isAuthenticated(req: InboundRequest): Promise<boolean> {
  // Check passphrase is configured; if not, auth is disabled.
  const passphrase = await kv.get("auth:passphrase");
  if (!passphrase) return true; // auth not configured → open access

  // Check session cookie.
  const cookies = getCookies(req);
  const token = cookies[SESSION_COOKIE] ?? "";
  if (token && await validateSession(token)) return true;

  // Check X-API-Key header (for programmatic/MCP access).
  const apiKey = getHeader(req, "x-api-key");
  if (apiKey) {
    const stored = await kv.get(`apikey:${apiKey}`);
    if (stored) return true;
  }

  return false;
}

function requireAuth(req: InboundRequest, handler: HttpHandler): Promise<OutboundResponse> | OutboundResponse {
  return (async () => {
    const authed = await isAuthenticated(req);
    if (!authed) return jsonErr("unauthorized", 401);
    return handler(req);
  })();
}

// ── Route matching ─────────────────────────────────────────────────────────────

interface Route {
  method: string;    // "GET" | "POST" | "DELETE" | "PATCH" | "*"
  pattern: RegExp;
  handler: (req: InboundRequest, match: RegExpMatchArray) => Promise<OutboundResponse> | OutboundResponse;
  auth: boolean;
}

const routes: Route[] = [];

function on(
  method: string,
  pattern: RegExp,
  handler: (req: InboundRequest, match: RegExpMatchArray) => Promise<OutboundResponse> | OutboundResponse,
  auth = true,
) {
  routes.push({ method, pattern, handler, auth });
}

async function dispatch(req: InboundRequest): Promise<OutboundResponse> {
  const path = req.path || "/";
  const method = req.httpMethod.toUpperCase();

  for (const route of routes) {
    if (route.method !== "*" && route.method !== method) continue;
    const match = path.match(route.pattern);
    if (!match) continue;
    if (route.auth) {
      const authed = await isAuthenticated(req);
      if (!authed) return jsonErr("unauthorized", 401);
    }
    return route.handler(req, match);
  }

  // Default: serve SPA shell for GET requests (client-side routing).
  if (method === "GET") return serveSPA(req);
  return jsonErr("not found", 404);
}

// ── SPA shell ─────────────────────────────────────────────────────────────────
// Serve index.html from the task directory (same folder as task.ts).
// All app assets are in app/ beside index.html and served by serveStatic.

async function serveSPA(_req: InboundRequest): Promise<OutboundResponse> {
  const taskDir = new URL(".", import.meta.url).pathname;
  try {
    const data = await Deno.readFile(taskDir + "index.html");
    return { status: 200, respHeaders: { "content-type": "text/html; charset=utf-8" }, respBody: data };
  } catch {
    return { status: 404, respBody: enc.encode("not found") };
  }
}

// ── Static app asset serving ───────────────────────────────────────────────────
// Serve files from the companion app/ directory next to task.ts.
// Since Deno tasks run with their task dir available, we read from disk.

const ALLOWED_EXT: Record<string, string> = {
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(req: InboundRequest, match: RegExpMatchArray): Promise<OutboundResponse> {
  const filePath = match[1] ?? "";
  // Guard against path traversal.
  const clean = filePath.replace(/\.\./g, "").replace(/\/+/g, "/");
  const ext = clean.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "";
  const mime = ALLOWED_EXT[ext];
  if (!mime) return jsonErr("not found", 404);

  // Resolve relative to this task's directory (injected by Deno runtime as import.meta.dirname).
  const taskDir = new URL(".", import.meta.url).pathname;
  const fullPath = taskDir + "app/" + clean.replace(/^\//, "");

  try {
    const data = await Deno.readFile(fullPath);
    return { status: 200, respHeaders: { "content-type": mime }, respBody: data };
  } catch {
    return jsonErr("not found", 404);
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────────

on("POST", /^\/api\/auth\/login$/, async (req) => {
  const body = parseJSON<{ password?: string; trust?: boolean }>(req);
  if (!body) return jsonErr("invalid JSON", 400);

  const expected = await kv.get("auth:passphrase");
  // If no passphrase configured, login always succeeds.
  if (expected && typeof expected === "string") {
    if (body.password !== expected) {
      return jsonErr("incorrect password", 401);
    }
  }

  const token = await issueSession();
  return {
    status: 200,
    respHeaders: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": sessionCookieHeader(token),
    },
    respBody: enc.encode(JSON.stringify({ status: "ok" })),
  };
}, false /* no auth required */);

on("POST", /^\/api\/auth\/refresh$/, async (req) => {
  // Check if the current session is still valid; if so issue a fresh one.
  const cookies = getCookies(req);
  const token = cookies[SESSION_COOKIE] ?? "";
  if (token && await validateSession(token)) {
    // Issue a fresh token to extend the session.
    const fresh = await issueSession();
    await revokeSession(token);
    return {
      status: 204,
      respHeaders: { "set-cookie": sessionCookieHeader(fresh) },
    };
  }
  return { status: 401 };
}, false);

on("POST", /^\/api\/auth\/logout$/, async (req) => {
  const cookies = getCookies(req);
  const token = cookies[SESSION_COOKIE] ?? "";
  if (token) await revokeSession(token);
  return {
    status: 200,
    respHeaders: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": clearCookieHeader(),
    },
    respBody: enc.encode(JSON.stringify({ status: "ok" })),
  };
});

on("POST", /^\/api\/auth\/logout-all$/, async (req) => {
  // Delete all session keys.
  const all = await kv.list("session:");
  await Promise.all(Object.keys(all).map((k) => kv.delete(k)));
  const cookies = getCookies(req);
  const token = cookies[SESSION_COOKIE] ?? "";
  return {
    status: 200,
    respHeaders: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": token ? clearCookieHeader() : "",
    },
    respBody: enc.encode(JSON.stringify({ status: "ok" })),
  };
});

// Passphrase status.
on("GET", /^\/api\/auth\/passphrase$/, async () => {
  const p = await kv.get("auth:passphrase");
  return json({ configured: !!p });
});

on("POST", /^\/api\/auth\/passphrase$/, async (req) => {
  const body = parseJSON<{ current?: string; passphrase?: string }>(req);
  if (!body || !body.passphrase) return jsonErr("passphrase required", 400);

  const existing = await kv.get("auth:passphrase");
  if (existing && typeof existing === "string") {
    if (body.current !== existing) return jsonErr("current passphrase incorrect", 403);
  }

  await kv.set("auth:passphrase", body.passphrase);
  // Invalidate all existing sessions.
  const all = await kv.list("session:");
  await Promise.all(Object.keys(all).map((k) => kv.delete(k)));
  return json({ status: "ok" });
});

// ── Task routes ────────────────────────────────────────────────────────────────

on("GET", /^\/api\/tasks$/, async () => {
  const tasks = await dicode.list_tasks();
  return json(tasks);
});

on("GET", /^\/api\/tasks\/([^/]+)$/, async (_req, match) => {
  const taskID = decodeURIComponent(match[1]);
  const tasks = await dicode.list_tasks();
  const task = tasks.find((t) => t.id === taskID);
  if (!task) return jsonErr("task not found", 404);
  return json(task);
});

on("POST", /^\/api\/tasks\/([^/]+)\/run$/, async (req, match) => {
  const taskID = decodeURIComponent(match[1]);
  let params: Record<string, string> = {};
  const ct = getHeader(req, "content-type");
  if (ct.includes("application/json")) {
    const body = parseJSON<Record<string, string>>(req);
    if (body) params = body;
  }
  try {
    const result = await dicode.run_task(taskID, params);
    return json({ status: "ok", result });
  } catch (err) {
    return jsonErr(String(err), 500);
  }
});

on("GET", /^\/api\/tasks\/([^/]+)\/runs$/, async (req, match) => {
  const taskID = decodeURIComponent(match[1]);
  const qs = parseQuery(req.query);
  const limit = Math.min(parseInt(qs.get("limit") ?? "20", 10), 100);
  try {
    const runs = await dicode.get_runs(taskID, { limit });
    return json(runs);
  } catch (err) {
    return jsonErr(String(err), 500);
  }
});

// ── AI chat SSE endpoint ───────────────────────────────────────────────────────
// POST /api/tasks/:id/ai/stream
// Reads AI config via dicode.get_config("ai"), streams text/file/error/done SSE events.

interface AICfg {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  model?: string;
}

interface AIEvent {
  type: "text" | "file" | "error" | "done";
  content?: string;
  filename?: string;
  message?: string;
}

function sseFrame(ev: AIEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

on("POST", /^\/api\/tasks\/([^/]+)\/ai\/stream$/, async (req, match) => {
  const taskID = decodeURIComponent(match[1]);

  let prompt = "";
  const ct = getHeader(req, "content-type");
  if (ct.includes("application/json")) {
    const body = parseJSON<{ prompt?: string }>(req);
    prompt = body?.prompt ?? "";
  } else {
    // Form-encoded
    const qs = new URLSearchParams(bodyText(req));
    prompt = qs.get("prompt") ?? "";
  }

  if (!prompt) return jsonErr("prompt required", 400);

  // Load AI config from daemon.
  const aiCfg = (await dicode.get_config("ai") ?? {}) as AICfg;

  let apiKey = aiCfg.api_key ?? "";
  if (!apiKey) {
    const envVar = aiCfg.api_key_env ?? "OPENAI_API_KEY";
    apiKey = Deno.env.get(envVar) ?? "";
  }
  const model = aiCfg.model ?? "gpt-4o";
  const baseURL = aiCfg.base_url ?? "https://api.openai.com/v1";

  if (!apiKey) {
    return sse(sseFrame({ type: "error", message: "AI API key not configured" }));
  }

  // Build the system prompt using task context from KV (task.yaml / task.js).
  const taskYAML = (await kv.get(`task:${taskID}:yaml`) as string) ?? "";
  const taskJS   = (await kv.get(`task:${taskID}:js`)   as string) ?? "";
  const testJS   = (await kv.get(`task:${taskID}:test`)  as string) ?? "";

  const systemPrompt = buildAISystem(taskID, taskYAML, taskJS, testJS);

  // Stream from OpenAI-compatible API.
  const events: string[] = [];

  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const body = JSON.stringify({
      model,
      stream: true,
      max_tokens: 4096,
      parallel_tool_calls: false,
      tools: aiTools(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: prompt },
      ],
    });

    const resp = await fetch(`${baseURL}/chat/completions`, { method: "POST", headers, body });
    if (!resp.ok) {
      const errText = await resp.text();
      events.push(sseFrame({ type: "error", message: `AI API error: ${errText}` }));
      events.push(sseFrame({ type: "done" }));
      return sse(events.join(""));
    }

    // Collect the entire stream (the IPC gateway buffers the full response).
    const reader = resp.body!.getReader();
    let buffer = "";
    const toolCalls: Record<number, { id: string; name: string; args: string }> = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string;
          }>;
        };
        try { chunk = JSON.parse(data); } catch { continue; }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Text delta.
        if (delta.content) {
          events.push(sseFrame({ type: "text", content: delta.content }));
        }

        // Tool call accumulation.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", args: "" };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
          }
        }

        // When a finish_reason appears, execute any pending tool calls.
        if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
          for (const tc of Object.values(toolCalls)) {
            if (tc.name === "write_file") {
              let inp: { filename?: string; content?: string } = {};
              try { inp = JSON.parse(tc.args); } catch { /* ignore */ }
              if (inp.filename && inp.content) {
                const allowed = ["task.js", "task.ts", "task.yaml", "task.test.js", "task.test.ts"];
                if (allowed.includes(inp.filename)) {
                  // Persist the file content in KV so the webui can serve it.
                  const kvKey = inp.filename.endsWith(".yaml")
                    ? `task:${taskID}:yaml`
                    : inp.filename.includes("test")
                    ? `task:${taskID}:test`
                    : `task:${taskID}:js`;
                  await kv.set(kvKey, inp.content);
                  events.push(sseFrame({ type: "file", filename: inp.filename, content: inp.content }));
                  log.info("AI wrote file", taskID, inp.filename);
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    events.push(sseFrame({ type: "error", message: String(err) }));
  }

  events.push(sseFrame({ type: "done" }));
  return sse(events.join(""));
});

function aiTools(): unknown[] {
  return [{
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a task file on disk. Call once per file. Use this to save task.js, task.yaml, and task.test.js.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            enum: ["task.js", "task.ts", "task.yaml", "task.test.js", "task.test.ts"],
            description: "Which file to write",
          },
          content: {
            type: "string",
            description: "Complete file contents — never truncated",
          },
        },
        required: ["filename", "content"],
      },
    },
  }];
}

function buildAISystem(taskID: string, taskYAML: string, taskJS: string, testJS: string): string {
  let s = `You are dicode's AI task assistant. Help the user create or modify dicode tasks.

dicode tasks are Deno TypeScript files (task.ts) with a matching task.yaml spec.
Always write complete files — never truncate. Use write_file for every file you create or modify.

---

## Current task files

**Task ID:** \`${taskID}\`

`;
  if (taskYAML) s += `**task.yaml:**\n\`\`\`yaml\n${taskYAML}\n\`\`\`\n\n`;
  if (taskJS)   s += `**task.js/ts:**\n\`\`\`javascript\n${taskJS}\n\`\`\`\n\n`;
  if (testJS)   s += `**task.test.js/ts:**\n\`\`\`javascript\n${testJS}\n\`\`\`\n\n`;
  s += "Use `write_file` for every file you create or modify. Always write the complete file contents.\n";
  return s;
}

// ── File editor API ────────────────────────────────────────────────────────────

const EDITABLE_FILES = new Set([
  "task.js", "task.ts", "task.py", "task.yaml",
  "task.test.js", "task.test.ts",
  "Dockerfile", "index.html", "style.css", "script.js",
]);

on("GET", /^\/api\/tasks\/([^/]+)\/files\/(.+)$/, async (_req, match) => {
  const taskID  = decodeURIComponent(match[1]);
  const filename = match[2];
  if (!EDITABLE_FILES.has(filename)) return jsonErr("file not allowed", 400);

  const kvKey = filename.endsWith(".yaml") ? `task:${taskID}:yaml`
    : filename.includes("test") ? `task:${taskID}:test`
    : `task:${taskID}:js`;

  const content = await kv.get(kvKey);
  if (content === null) return jsonErr("file not found", 404);
  return text(String(content));
});

on("POST", /^\/api\/tasks\/([^/]+)\/files\/(.+)$/, async (req, match) => {
  const taskID  = decodeURIComponent(match[1]);
  const filename = match[2];
  if (!EDITABLE_FILES.has(filename)) return jsonErr("file not allowed", 400);

  let content = "";
  const ct = getHeader(req, "content-type");
  if (ct.includes("text/plain")) {
    content = bodyText(req);
  } else {
    const body = parseJSON<{ content?: string }>(req);
    content = body?.content ?? "";
  }

  const kvKey = filename.endsWith(".yaml") ? `task:${taskID}:yaml`
    : filename.includes("test") ? `task:${taskID}:test`
    : `task:${taskID}:js`;

  await kv.set(kvKey, content);
  log.info("file saved", taskID, filename);
  return json({ status: "saved" });
});

// ── Config routes ──────────────────────────────────────────────────────────────

on("GET", /^\/api\/config$/, async () => {
  try {
    const cfg = await dicode.get_config("all");
    return json(cfg);
  } catch {
    return json({});
  }
});

// ── WebSocket live log streaming ───────────────────────────────────────────────
// The IPC gateway delivers WebSocket upgrade requests as regular HTTP requests
// with an "Upgrade: websocket" header. For the built-in webui daemon, the daemon
// owns the WebSocket endpoint at the Go level. The Deno task bridges the event
// bus by sending log/run events over SSE-style framing within a long-poll
// connection.
//
// Implementation note: The dicode IPC gateway does NOT support WebSocket upgrade
// forwarding in the current protocol (it buffers full request/response pairs).
// The /ws endpoint is therefore implemented as a long-poll SSE stream that the
// SPA's ws.js lib can consume via EventSource in degraded mode, or we serve a
// minimal WebSocket-like polling endpoint.
//
// Since the underlying gateway serialises request-response pairs, we implement
// /ws as an SSE endpoint that streams buffered events from KV (set by other tasks
// or the daemon itself via run:log / run:started / run:finished hooks that are
// published to a KV pub/sub channel "ws:events").
//
// For a real WebSocket you would need native WebSocket support in the gateway;
// this is a best-effort degraded implementation.

on("GET", /^\/ws$/, async (req) => {
  // If the client upgrades to WebSocket, we can't upgrade over IPC.
  // Return a 426 Upgrade Required with a note, so the SPA can fall back to polling.
  const upgrade = getHeader(req, "upgrade");
  if (upgrade.toLowerCase() === "websocket") {
    return {
      status: 426,
      respHeaders: {
        "content-type": "text/plain",
        "upgrade": "websocket",
      },
      respBody: enc.encode("WebSocket not supported over IPC gateway; use SSE /api/events instead"),
    };
  }
  return jsonErr("use /api/events for event streaming", 400);
});

// SSE event stream — clients can subscribe here instead of WebSocket.
// Events are published to KV key "ws:pending" as a JSON array and drained.
on("GET", /^\/api\/events$/, async () => {
  const pending = await kv.get("ws:pending");
  let events = "";
  if (Array.isArray(pending)) {
    for (const ev of pending) {
      events += `data: ${JSON.stringify(ev)}\n\n`;
    }
    await kv.delete("ws:pending");
  }
  // If no pending events, send a heartbeat comment.
  if (!events) events = ": heartbeat\n\n";
  return sse(events);
});

// ── Static app assets ─────────────────────────────────────────────────────────

on("GET", /^\/app\/(.+)$/, serveStatic, false /* static assets are public */);

// dicode.js client SDK — served publicly.
on("GET", /^\/dicode\.js$/, async () => {
  const taskDir = new URL(".", import.meta.url).pathname;
  try {
    const data = await Deno.readFile(taskDir + "static/dicode.js");
    return {
      status: 200,
      respHeaders: { "content-type": "application/javascript; charset=utf-8" },
      respBody: data,
    };
  } catch {
    return jsonErr("not found", 404);
  }
}, false);

// Run result page (bare output, no SPA chrome).
on("GET", /^\/runs\/([^/]+)\/result$/, async (_req, match) => {
  const runID = match[1];
  // We don't have direct run access here; redirect to the SPA which will fetch via API.
  return {
    status: 302,
    respHeaders: { "location": `/?runResult=${encodeURIComponent(runID)}` },
  };
});

// ── Main HTTP handler registration ────────────────────────────────────────────

log.info("webui task starting, registering HTTP handler");

http.register("GET /*", async (req: InboundRequest) => {
  try {
    const resp = await dispatch(req);
    // Add security headers to every response.
    const headers: Record<string, string> = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...resp.respHeaders,
    };
    return { ...resp, respHeaders: headers };
  } catch (err) {
    log.error("webui handler error", String(err));
    return json({ error: "internal server error" }, 500);
  }
});

// Also register POST /* so form submissions and API calls reach us.
http.register("POST /*", async (req: InboundRequest) => {
  try {
    const resp = await dispatch(req);
    const headers: Record<string, string> = {
      "x-content-type-options": "nosniff",
      ...resp.respHeaders,
    };
    return { ...resp, respHeaders: headers };
  } catch (err) {
    log.error("webui handler error", String(err));
    return json({ error: "internal server error" }, 500);
  }
});

http.register("DELETE /*", async (req: InboundRequest) => {
  try {
    return await dispatch(req);
  } catch (err) {
    log.error("webui handler error", String(err));
    return json({ error: "internal server error" }, 500);
  }
});

http.register("PATCH /*", async (req: InboundRequest) => {
  try {
    return await dispatch(req);
  } catch (err) {
    log.error("webui handler error", String(err));
    return json({ error: "internal server error" }, 500);
  }
});

log.info("webui task ready");

// Keep the daemon alive (daemon tasks must not exit).
await new Promise<never>(() => {/* run forever */});
