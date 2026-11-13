// The AI providers Minutes runs its agents with. A provider is connected by a pasted key or by an
// OAuth sign-in that yields one; the key reaches clai as `env`. `models` are the -cm/-am each
// agent then runs with, null keeping the profiles' own. The first connected provider is used.

// `+diarize` asks clai for speaker labels; scribe-v2 is the one OpenRouter model that gives them.
export const OPENROUTER_AUDIO = "or:elevenlabs/scribe-v2+diarize";

export const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    stored: "minutes.openai-key",
    connect: "key",
    hosts: ["api.openai.com"],
    models: null,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    stored: "minutes.openrouter-key",
    connect: "oauth",
    hosts: ["openrouter.ai"],
    // OpenRouter's PKCE flow: https://openrouter.ai/docs/guides/overview/auth/oauth
    oauth: { authorize: "https://openrouter.ai/auth", exchange: "https://openrouter.ai/api/v1/auth/keys", label: "Minutes" },
    manage: async (key) => `https://openrouter.ai/keys/${await sha256Hex(key)}`,
    models: {
      agent: { chat: "or:openai/gpt-5.6-luna", audio: OPENROUTER_AUDIO },
      penelope: { chat: "or:openai/gpt-6.1-sol" },
    },
  },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) ?? null;

export const activeProvider = (env) => PROVIDERS.find((p) => env.has(p.env)) ?? null;

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// The clai flags `role` ("agent" or "penelope") runs with on `provider`, "" for the profile's own.
export function providerFlags(provider, role) {
  const m = provider?.models?.[role];
  if (!m) return "";
  return [m.chat && `-cm ${quote(m.chat)}`, m.audio && `-am ${quote(m.audio)}`].filter(Boolean).join(" ");
}

export function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function challengeOf(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

// A PKCE verifier and its S256 challenge (RFC 7636), and a state for the callback to echo.
export async function pkce(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const verifier = base64url(random(32));
  return { verifier, challenge: await challengeOf(verifier), state: base64url(random(16)) };
}

export function authorizeUrl(provider, { callback, challenge, state }) {
  const url = new URL(provider.oauth.authorize);
  url.search = new URLSearchParams({
    callback_url: callback, code_challenge: challenge, code_challenge_method: "S256", key_label: provider.oauth.label, state,
  }).toString();
  return url.href;
}

// Trades the callback's code for the provider's key; a refusal throws with the provider's words.
export async function exchangeCode(provider, { code, verifier }, fetchFn = fetch) {
  const response = await fetchFn(provider.oauth.exchange, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status and the text say what went wrong.
  }
  if (!response.ok) {
    const said = body?.error?.message ?? body?.message ?? text.trim().slice(0, 200);
    throw new Error(`${provider.name} refused the sign-in (${response.status}${said ? `: ${said}` : ""})`);
  }
  if (typeof body?.key !== "string" || !body.key) throw new Error(`${provider.name} sent no key`);
  return body.key;
}

// What the callback page posts: the code and state on approval, an error otherwise.
export function callbackMessage(search) {
  const q = new URLSearchParams(search);
  return { code: q.get("code"), state: q.get("state"), error: q.get("error_description") ?? q.get("error") };
}

export const SIGNIN_CHANNEL = "minutes-signin";
