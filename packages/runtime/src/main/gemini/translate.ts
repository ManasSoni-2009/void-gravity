/**
 * Translating between Antigravity's Cloud Code endpoint and the public Gemini
 * API.
 *
 * Everything here is pure: bytes and a registry in, bytes out. The hard parts
 * of this feature are the guesses — which public model an internal enum means,
 * how much thinking to ask for, how a streamed event is re-wrapped — and
 * keeping them in one file means they can be tested without a socket, a
 * certificate, or a running language server. The transport is in `proxy.ts`.
 *
 * The shapes are Google's on both sides. The language server speaks a Cloud
 * Code dialect that wraps an ordinary Gemini request in `{"request": {...}}`
 * and wants `{"response": {...}, "traceId", "metadata"}` back as server-sent
 * events; the public API takes and returns the inner halves. So the work is
 * unwrapping, re-wrapping, and naming the model.
 */

import crypto from "node:crypto";

export const PUBLIC_HOST = "generativelanguage.googleapis.com";
/** The only Cloud Code host Antigravity 2.12.0 talks to. */
export const CCPA_HOST = "daily-cloudcode-pa.googleapis.com";
export const CHAT_PATH_PREFIX = "/v1internal:streamGenerateContent";
export const CATALOG_PATH_PREFIX = "/v1internal:fetchAvailableModels";

/** How Antigravity's own catalog labels a model served by the Gemini API. */
export const GEMINI_PROVIDER = "API_PROVIDER_GOOGLE_GEMINI";

// ── Where the translated requests go ─────────────────────────────────────────

/**
 * Google's public API, or whatever the panel was pointed at instead: a relay of
 * one's own, a gateway a workplace insists on, something listening on this
 * machine. The standard `/v1beta/...` path is appended to `prefix`, so anything
 * that speaks the public Gemini API works without further explanation.
 */
export interface BaseTarget {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number | undefined;
  /** A path the relay lives under, without its trailing slash. Usually empty. */
  readonly prefix: string;
  /** What to print when naming it. */
  readonly origin: string;
  /** Why the text was refused, when it was — in which case this is Google's. */
  readonly problem: string | undefined;
}

export const GOOGLE_BASE: BaseTarget = {
  secure: true,
  host: PUBLIC_HOST,
  port: undefined,
  prefix: "",
  origin: `https://${PUBLIC_HOST}`,
  problem: undefined
};

/** Where an unencrypted address is nobody else's business but this machine's. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Reads what was typed into the panel. Always returns something usable: a base
 * URL that cannot be understood falls back to Google's own and carries the
 * reason, because a typo should cost the user a sentence in the panel rather
 * than their chat.
 */
export function parseBaseUrl(raw: string): BaseTarget {
  const text = raw.trim();
  if (text === "") return GOOGLE_BASE;

  const refused = (problem: string): BaseTarget => ({ ...GOOGLE_BASE, problem });

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refused(`The base URL is not an address, so requests are going to ${PUBLIC_HOST}.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refused(`A base URL has to start with https://, so requests are going to ${PUBLIC_HOST}.`);
  }
  if (url.hostname === "") {
    return refused(`The base URL names no host, so requests are going to ${PUBLIC_HOST}.`);
  }
  // Plain http off this machine would put the key on the wire in clear text.
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    return refused(`http:// would send your key unencrypted, so requests are going to ${PUBLIC_HOST}.`);
  }

  const secure = url.protocol === "https:";
  const port = url.port === "" ? undefined : Number(url.port);
  const prefix = url.pathname.replace(/\/+$/, "");
  return {
    secure,
    host: url.hostname,
    port,
    prefix,
    origin: `${url.protocol}//${url.host}${prefix}`,
    problem: undefined
  };
}

/**
 * The `modelVersion` every wrapped response carries. Cloud Code reports an
 * internal name here rather than a public model id, so this is sent verbatim
 * rather than echoing whichever model actually answered.
 */
export const MODEL_VERSION = "gemini-3-flash-a";

/** Thirty minutes: new models ship on the order of days, not seconds. */
export const PUBLIC_MODELS_TTL_MS = 30 * 60 * 1000;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * What a model enum resolves to. One dial or the other: Gemini 3.x takes a
 * `thinkingLevel`, 2.5 takes a numeric `thinkingBudget`, and sending both is a
 * request error.
 */
export interface Resolution {
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly thinkingBudget: number | null;
}

/** One model as Antigravity's catalog describes it, keyed by its enum. */
export interface CatalogModel {
  /** Antigravity's internal name, which is sometimes the public one too. */
  readonly alias: string;
  readonly displayName: string;
  readonly apiProvider: string;
  readonly modelProvider: string;
  readonly thinkingBudget: number | null;
  readonly minThinkingBudget: number | null;
  readonly supportsThinking: boolean;
}

const withLevel = (model: string, thinkingLevel: ThinkingLevel): Resolution => ({
  model,
  thinkingLevel,
  thinkingBudget: null
});

/**
 * The fallback for the moment before Antigravity's catalog arrives. The agent
 * fires its first requests while `fetchAvailableModels` is still in flight, and
 * without these they bill the bundled subscription and rate-limit the account
 * that the user's own key was meant to spare.
 *
 * These enum numbers are not stable across Antigravity versions — they are
 * 2.12.0's. Anything missing or renamed simply falls through to the live
 * catalog, which is why being out of date here costs a few requests and not
 * the feature.
 */
const STATIC_MODELS: Readonly<Record<string, Resolution>> = {
  // Gemini 4 Family mappings (routed to user's API key)
  MODEL_PLACEHOLDER_M421: withLevel("gemini-4-argon", "high"),
  MODEL_PLACEHOLDER_M529: withLevel("gemini-4-hydrogen", "high"),
  MODEL_PLACEHOLDER_M536: withLevel("gemini-4-neon", "high"),
  MODEL_PLACEHOLDER_M670: withLevel("gemini-4-carbon", "high"),
  MODEL_PLACEHOLDER_M578: withLevel("gemini-4-hydrogen", "high")
};

/** Model ids that do not serve chat the way `streamGenerateContent` needs. */
const SPECIALTY_MARKERS = [
  "-image",
  "-tts",
  "-audio",
  "-live",
  "-computer-use",
  "-embedding",
  "-native-audio",
  "-live-translate",
  "-customtools"
] as const;

/** The same idea applied to a catalog entry's own words rather than an id. */
const NON_CHAT_WORDS = [
  "image",
  "video",
  "audio",
  "tts",
  "embedding",
  "computer use",
  "computer-use",
  "live"
] as const;

export type ModelFamily = "pro" | "flash" | "flash-lite";

export interface FamilyGuess {
  /** `"3.5"`, `"3"`, `"2.5"`; absent when no field states one. */
  readonly version: string | undefined;
  readonly family: ModelFamily;
}

/**
 * The version to trust, which differs by enum shape because the catalog's own
 * fields disagree:
 *
 *   MODEL_PLACEHOLDER_M84   gemini-3-flash-agent   "Gemini 3.5 Flash (High)"
 *   MODEL_GOOGLE_GEMINI_2_5_FLASH   gemini-2.5-flash   "Gemini 3.1 Flash Lite"
 *
 * An alias lags the real version or omits it, so the display name wins for
 * placeholder enums. For the 2.5 family the display name is plainly wrong —
 * three distinct models share one label — while the enum states the version
 * outright, so that wins instead.
 */
export function versionFor(alias: string, display: string, modelEnum: string): string | undefined {
  const number = /(\d+\.\d+|\d+)/;
  if (modelEnum.startsWith("MODEL_GOOGLE_GEMINI_")) {
    const stated = /MODEL_GOOGLE_GEMINI_(\d+)_(\d+)/.exec(modelEnum);
    if (stated) return `${stated[1]}.${stated[2]}`;
    return number.exec(alias)?.[1];
  }
  for (const source of [display, alias]) {
    const found = number.exec(source);
    if (found) return found[1];
  }
  return undefined;
}

/**
 * The version and family Antigravity is asking for, or nothing when the entry
 * is not a chat model at all. The family comes from the alias where it can,
 * because an alias names the family reliably even when its version is stale.
 */
export function parseFamily(alias: string, display: string, modelEnum = ""): FamilyGuess | undefined {
  const text = `${alias} ${display}`.toLowerCase();
  if (NON_CHAT_WORDS.some((word) => text.includes(word))) return undefined;
  // Autocomplete and other internal models are not chat models.
  if (alias.startsWith("tab_") || alias.startsWith("chat_")) return undefined;

  for (const source of [alias.toLowerCase(), display.toLowerCase()]) {
    const version = versionFor(alias, display, modelEnum);
    if (source.includes("flash lite") || source.includes("flash-lite")) {
      return { version, family: "flash-lite" };
    }
    if (source.includes("pro")) return { version, family: "pro" };
    if (source.includes("flash")) return { version, family: "flash" };
  }
  return undefined;
}

/** `"3.5"` → `[3, 5]`, so versions compare the way their numbers read. */
function versionTuple(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** Element by element, with a missing element ranking below any present one. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface Candidate {
  readonly id: string;
  readonly version: readonly number[];
  readonly preview: boolean;
}

/** Ids in this family, exactly: flash-lite is not flash. */
function candidatesFor(family: ModelFamily, available: ReadonlySet<string>): readonly Candidate[] {
  const found: Candidate[] = [];
  for (const id of available) {
    if (!id.startsWith("gemini-")) continue;
    if (SPECIALTY_MARKERS.some((marker) => id.includes(marker))) continue;
    if (family === "flash-lite" && !id.includes("flash-lite")) continue;
    if (family === "flash" && (!id.includes("flash") || id.includes("flash-lite"))) continue;
    if (family === "pro" && !id.includes("pro")) continue;
    const stated = /^gemini-(\d+(?:\.\d+)?)/.exec(id);
    if (!stated) continue;
    found.push({ id, version: versionTuple(stated[1] ?? ""), preview: id.includes("-preview") });
  }
  return found;
}

export interface BestModel {
  readonly id: string;
  /** True when the version asked for was not on offer and an older one is used. */
  readonly downgraded: boolean;
}

/**
 * The best real id for a version and family, out of what the key actually
 * serves. Exact version first, stable before preview; failing that the nearest
 * *lower* version, which keeps a newly announced model billing to the user's
 * key instead of quietly falling back to the subscription — the whole point of
 * the feature. A downgrade is reported so the caller can say so out loud.
 */
export function bestPublicModel(
  version: string | undefined,
  family: ModelFamily | undefined,
  available: ReadonlySet<string>
): BestModel | undefined {
  if (available.size === 0 || !version || !family) return undefined;
  const candidates = candidatesFor(family, available);
  if (candidates.length === 0) return undefined;
  const wanted = versionTuple(version);

  const exact = candidates.filter((candidate) => compareVersions(candidate.version, wanted) === 0);
  if (exact.length > 0) {
    // Stable before preview; the shortest id then wins, so the canonical name
    // beats a dated variant of it.
    exact.sort((left, right) => Number(left.preview) - Number(right.preview) || left.id.length - right.id.length);
    return { id: exact[0]?.id ?? "", downgraded: false };
  }

  const lower = candidates.filter((candidate) => compareVersions(candidate.version, wanted) < 0);
  if (lower.length === 0) return undefined;
  lower.sort((left, right) => compareVersions(right.version, left.version) || Number(left.preview) - Number(right.preview));
  return { id: lower[0]?.id ?? "", downgraded: true };
}

/**
 * How much thinking to ask for. The display name says it outright when
 * Antigravity offers the same model at several depths — "Gemini 3.1 Pro (High)"
 * — and otherwise it is derived from the numeric budget the catalog carries.
 */
export function pickThinkingLevel(
  display: string,
  budget: number | null,
  supportsThinking: boolean,
  apiModel: string
): ThinkingLevel {
  let level: ThinkingLevel;
  if (display.includes("(High)")) level = "high";
  else if (display.includes("(Medium)")) level = "medium";
  else if (display.includes("(Low)")) level = "low";
  else if (budget === 0) level = "minimal";
  else if (!supportsThinking && (budget === null || budget === 0)) level = "minimal";
  // -1 is a dynamic budget, which is effectively high.
  else if (budget === null || budget === -1) level = "high";
  else if (budget < 5000) level = "low";
  else if (budget < 50_000) level = "medium";
  else level = "high";

  // Pro does not accept `minimal`; every Flash variant does.
  return apiModel.includes("-pro") && level === "minimal" ? "low" : level;
}

export interface CatalogPick {
  readonly resolution: Resolution;
  /** Why this id is a guess, when it is one. */
  readonly note: string | undefined;
}

/** Models whose display name says they are not for chat. */
const SPECIALTY_LABELS = ["Image", "Video", "Audio"] as const;

/**
 * What one Gemini-family catalog entry should be translated to, or nothing when
 * it should be left to the subscription.
 */
export function pickFromCatalog(
  modelEnum: string,
  entry: CatalogModel,
  available: ReadonlySet<string>
): CatalogPick | undefined {
  const { alias, displayName: display, thinkingBudget: budget } = entry;
  if (SPECIALTY_LABELS.some((label) => display.includes(label))) return undefined;
  const al = (alias || "").toLowerCase();
  const dn = (display || "").toLowerCase();
  const en = (modelEnum || "").toLowerCase();
  const isG4 = al.includes("gemini-4") || dn.includes("gemini 4") || en.includes("gemini_4") || en.includes("m421") || en.includes("m529") || en.includes("m536") || en.includes("m670") || en.includes("m578");
  const isDis = entry.disabled === true || al.includes("-disabled") || dn.includes("disabled");
  if (!isG4 && !isDis) return undefined; // Let standard models pass through to Antigravity subscription!

  let target = "gemini-4-hydrogen";
  const cl = al.replace(/-disabled$/, "").replace(/-sonar$/, "");
  if (cl.includes("argon") || dn.includes("argon")) target = "gemini-4-argon";
  else if (cl.includes("hydrogen") || dn.includes("hydrogen")) target = "gemini-4-hydrogen";
  else if (cl.includes("neon") || dn.includes("neon")) target = "gemini-4-neon";
  else if (cl.includes("carbon") || dn.includes("carbon")) target = "gemini-4-carbon";
  else if (available.has(cl)) target = cl;

  return { resolution: { model: target, thinkingLevel: "high", thinkingBudget: null }, note: undefined };
}

export function nameFromDisplay(display: string): { readonly model: string; readonly note: string | undefined } | undefined {
  const text = display.toLowerCase();
  const guessed = (model: string): { model: string; note: string } => ({
    model,
    note: `${display} is not on this key; guessing ${model}`
  });

  const versionMatch = /(\d+\.\d+|\d+)/.exec(text);
  const version = versionMatch ? versionMatch[1] : undefined;

  if (text.includes("flash lite") || text.includes("flash-lite")) {
    return guessed(version ? `gemini-${version}-flash-lite` : "gemini-3.1-flash-lite");
  }

  if (text.includes("flash")) {
    return guessed(version ? `gemini-${version}-flash` : "gemini-3.5-flash");
  }

  if (text.includes("pro")) {
    if (version && version !== "3.1") {
      return guessed(`gemini-${version}-pro`);
    }
    return guessed("gemini-3.1-pro-preview");
  }

  return undefined;
}

// ── Reading what the wire says ───────────────────────────────────────────────

function parseJson(body: string | Buffer): unknown {
  try {
    return JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Non-empty text, which is what Google's `bool(part["text"])` amounts to. */
function hasText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * The ids the key itself says it serves, from `ListModels`. Anything that
 * cannot answer `generateContent` is dropped, so an embedding model never wins
 * a family match.
 */
export function publicModelNames(body: string | Buffer): readonly string[] {
  const data = asRecord(parseJson(body));
  const names: string[] = [];
  for (const raw of asArray(data?.["models"])) {
    const model = asRecord(raw);
    if (!model) continue;
    const name = asText(model["name"]).replace("models/", "").trim();
    if (name.length === 0) continue;
    const methods = asArray(model["supportedGenerationMethods"]);
    if (methods.length > 0 && !methods.some((method) => asText(method).includes("generateContent"))) continue;
    names.push(name);
  }
  return names;
}

/**
 * Antigravity's catalog, keyed by enum rather than by alias, because the enum is
 * what a chat request carries.
 */
export function catalogModels(body: string | Buffer): ReadonlyMap<string, CatalogModel> {
  const data = asRecord(parseJson(body));
  const models = asRecord(data?.["models"]) ?? {};
  const cache = new Map<string, CatalogModel>();
  for (const [alias, raw] of Object.entries(models)) {
    const info = asRecord(raw);
    if (!info) continue;
    const modelEnum = asText(info["model"]);
    if (modelEnum.length === 0) continue;
    cache.set(modelEnum, {
      alias,
      displayName: asText(info["displayName"]),
      apiProvider: asText(info["apiProvider"]),
      modelProvider: asText(info["modelProvider"]),
      thinkingBudget: asNumber(info["thinkingBudget"]),
      minThinkingBudget: asNumber(info["minThinkingBudget"]),
      supportsThinking: info["supportsThinking"] === true
    });
  }
  return cache;
}

export interface PublicModelUpdate {
  readonly count: number;
  /** Ids that were not there before. Empty on the first fetch, which is not news. */
  readonly added: readonly string[];
}

/**
 * What is known about models, from the two directions it arrives from:
 * Antigravity's catalog says what the editor is offering, and the key's own
 * model list says what can actually be asked for. Resolution is the meeting of
 * the two, so both are kept in one place.
 */
export class ModelRegistry {
  private catalog: ReadonlyMap<string, CatalogModel> = new Map();
  private available: ReadonlySet<string> = new Set();
  /** Zero until the key's model list has been read at least once. */
  private fetchedAt = 0;

  get catalogSize(): number {
    return this.catalog.size;
  }

  get availableSize(): number {
    return this.available.size;
  }

  publicModelsStale(now = Date.now()): boolean {
    return this.fetchedAt === 0 || now - this.fetchedAt >= PUBLIC_MODELS_TTL_MS;
  }

  rememberPublicModels(ids: readonly string[], now = Date.now()): PublicModelUpdate {
    const before = this.available;
    const next = new Set(ids);
    this.available = next;
    this.fetchedAt = now;
    const added = before.size === 0 ? [] : [...next].filter((id) => !before.has(id)).sort();
    return { count: next.size, added };
  }

  updateFromCatalog(body: string | Buffer): number {
    const next = catalogModels(body);
    if (next.size === 0) return 0;
    this.catalog = next;
    return next.size;
  }

  resolve(modelEnum: string): Resolution | undefined {
    const entry = this.catalog.get(modelEnum);
    if (entry) {
      if (entry.apiProvider !== GEMINI_PROVIDER) return undefined;
      return pickFromCatalog(modelEnum, entry, this.available)?.resolution;
    }
    return STATIC_MODELS[modelEnum];
  }

  summarize(): readonly string[] {
    const lines: string[] = [];
    for (const [modelEnum, entry] of [...this.catalog].sort(([left], [right]) => left.localeCompare(right))) {
      const label = `${modelEnum} ${entry.alias} (${entry.displayName})`;
      if (entry.apiProvider !== GEMINI_PROVIDER) {
        lines.push(`${label} -> subscription, ${entry.apiProvider || "no provider"}`);
        continue;
      }
      const picked = pickFromCatalog(modelEnum, entry, this.available);
      if (!picked) {
        lines.push(`${label} -> subscription`);
        continue;
      }
      const { model, thinkingLevel, thinkingBudget } = picked.resolution;
      const dial = thinkingLevel !== null ? `level=${thinkingLevel}` : `budget=${thinkingBudget ?? "default"}`;
      lines.push(`${label} -> ${model} ${dial}${picked.note ? ` (${picked.note})` : ""}`);
    }
    return lines;
  }
}

// ── The request going out ────────────────────────────────────────────────────

export interface ChatRequest {
  readonly inner: Record<string, unknown>;
  readonly sourceEnum: string;
}

export function readChatRequest(body: string | Buffer): ChatRequest | undefined {
  const outer = asRecord(parseJson(body));
  if (!outer) return undefined;
  const inner = asRecord(outer["request"]) ?? {};
  const sourceEnum = asText(asRecord(inner["labels"])?.["model_enum"]);
  delete inner["labels"];
  delete inner["sessionId"];
  return { inner, sourceEnum };
}

export function applyThinkingConfig(
  inner: Record<string, unknown>,
  resolution: Resolution,
  includeThoughts: boolean
): void {
  const generation = asRecord(inner["generationConfig"]) ?? {};
  const thinking = asRecord(generation["thinkingConfig"]) ?? {};
  delete thinking["thinkingLevel"];
  delete thinking["thinkingBudget"];
  if (resolution.thinkingLevel !== null) thinking["thinkingLevel"] = resolution.thinkingLevel;
  if (resolution.thinkingBudget !== null) thinking["thinkingBudget"] = resolution.thinkingBudget;
  thinking["includeThoughts"] = includeThoughts;
  generation["thinkingConfig"] = thinking;
  inner["generationConfig"] = generation;
}

export function newTraceId(): string {
  return crypto.randomBytes(8).toString("hex");
}

// ── The response coming back ─────────────────────────────────────────────────

export interface SseScan {
  readonly events: readonly string[];
  readonly rest: Buffer;
}

export function splitEvents(buffered: Buffer): SseScan {
  const events: string[] = [];
  let rest = buffered;
  for (;;) {
    const crlf = rest.indexOf("\r\n\r\n");
    const lf = rest.indexOf("\n\n");
    let at = -1;
    let width = 0;
    if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
      at = crlf;
      width = 4;
    } else if (lf >= 0) {
      at = lf;
      width = 2;
    }
    if (at < 0) break;
    const event = rest.subarray(0, at).toString("utf8");
    rest = rest.subarray(at + width);
    if (event.trim().length > 0) events.push(event);
  }
  return { events, rest };
}

export function readEventData(event: string): readonly Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const line of event.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = asRecord(parseJson(line.slice(6)));
    if (parsed) payloads.push(parsed);
  }
  return payloads;
}

const STREAM_USAGE_FIELDS = [
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "thoughtsTokenCount",
  "cachedContentTokenCount"
] as const;

const BUFFERED_USAGE_FIELDS = STREAM_USAGE_FIELDS.slice(0, 4);

function pruneUsage(usage: Record<string, unknown> | undefined, fields: readonly string[]): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};
  if (!usage) return pruned;
  for (const field of fields) if (field in usage) pruned[field] = usage[field];
  return pruned;
}

function cleanCandidate(candidate: Record<string, unknown>, hasUsage: boolean, includeThoughts: boolean): void {
  delete candidate["index"];
  const content = asRecord(candidate["content"]) ?? {};
  const hasRole = "role" in content;
  const kept: Record<string, unknown>[] = [];

  for (const raw of asArray(content["parts"])) {
    const part = asRecord(raw);
    if (!part) continue;
    if (!hasUsage && !hasRole && hasText(part["text"]) && !part["thought"]) part["thought"] = true;
    if (part["thought"] && !includeThoughts) continue;
    const substantive =
      hasText(part["text"]) ||
      "functionCall" in part ||
      "functionResponse" in part ||
      "thoughtSignature" in part;
    if (substantive) kept.push(part);
  }

  if (kept.length > 0) candidate["content"] = { role: "model", parts: kept };
  else if (candidate["finishReason"]) candidate["content"] = { role: "model", parts: [{ text: "" }] };
  else delete candidate["content"];
}

export function wrapEvent(payload: Record<string, unknown>, traceId: string, includeThoughts: boolean): string {
  const hasUsage = "usageMetadata" in payload;
  for (const raw of asArray(payload["candidates"])) {
    const candidate = asRecord(raw);
    if (candidate) cleanCandidate(candidate, hasUsage, includeThoughts);
  }
  payload["usageMetadata"] = pruneUsage(asRecord(payload["usageMetadata"]), STREAM_USAGE_FIELDS);
  payload["modelVersion"] = MODEL_VERSION;
  return `data: ${JSON.stringify({ response: payload, traceId, metadata: {} })}\n\n`;
}

export interface Consolidated {
  readonly body: string;
  readonly textLength: number;
  readonly thoughtLength: number;
  readonly actionCount: number;
}

export function consolidate(
  payloads: readonly Record<string, unknown>[],
  traceId: string,
  includeThoughts: boolean
): Consolidated {
  const thoughts: string[] = [];
  const spoken: string[] = [];
  const actions: Record<string, unknown>[] = [];
  const signatures: string[] = [];
  let finishReason = "";
  let usage: Record<string, unknown> | undefined;
  let responseId = "";

  for (const payload of payloads) {
    const first = asRecord(asArray(payload["candidates"])[0]);
    const content = asRecord(first?.["content"]);
    const reason = asText(first?.["finishReason"]);
    if (reason.length > 0) finishReason = reason;
    for (const raw of asArray(content?.["parts"])) {
      const part = asRecord(raw);
      if (!part) continue;
      const isAction = "functionCall" in part || "functionResponse" in part;
      if (isAction) {
        actions.push(part);
      } else if (hasText(part["text"])) {
        const unflaggedThought = !("usageMetadata" in payload) && !(content && "role" in content);
        (part["thought"] || unflaggedThought ? thoughts : spoken).push(asText(part["text"]));
      }
      if (!isAction && hasText(part["thoughtSignature"])) signatures.push(asText(part["thoughtSignature"]));
    }
    const seen = asRecord(payload["usageMetadata"]);
    if (seen && Object.keys(seen).length > 0) usage = seen;
    const seenId = asText(payload["responseId"]);
    if (seenId.length > 0) responseId = seenId;
  }

  const pruned = pruneUsage(usage, BUFFERED_USAGE_FIELDS);
  const parts: Record<string, unknown>[] = [...actions];
  if (includeThoughts && thoughts.length > 0) parts.push({ text: thoughts.join(""), thought: true });
  if (spoken.length > 0) parts.push({ text: spoken.join("") });
  const last = signatures[signatures.length - 1];
  const first = parts[0];
  if (last !== undefined && first) parts[0] = { ...first, thoughtSignature: last };

  const envelope = (response: Record<string, unknown>): string =>
    `data: ${JSON.stringify({ response, traceId, metadata: {} })}\n\n`;
  let body = "";
  if (parts.length > 0) {
    body += envelope({
      candidates: [{ content: { role: "model", parts } }],
      usageMetadata: pruned,
      modelVersion: MODEL_VERSION,
      responseId
    });
  }
  body += envelope({
    candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: finishReason || "STOP" }],
    usageMetadata: pruned,
    modelVersion: MODEL_VERSION,
    responseId
  });

  return {
    body,
    textLength: spoken.join("").length,
    thoughtLength: thoughts.join("").length,
    actionCount: actions.length
  };
}

// ── The catalog on its way back to the editor ────────────────────────────────

export function neutralizeQuota(body: string | Buffer): string | undefined {
  const data = asRecord(parseJson(body));
  const models = asRecord(data?.["models"]) as Record<string, Record<string, unknown>> | undefined;
  if (!data || !models) return undefined;
  let changed = 0;

  const g4Models = [
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { id: "gemini-4-neon", name: "Gemini 4 Neon" },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon" }
  ];

  for (const [i, s] of Object.entries(models)) {
    if (!s) continue;
    const quota = (asRecord(s["quotaInfo"]) ?? {}) as Record<string, unknown>;
    s["quotaInfo"] = quota;
    const al = (i || "").toLowerCase();
    const dn = (asText(s["displayName"]) || "").toLowerCase();
    const isG4 = al.includes("gemini-4") || dn.includes("gemini 4");
    const isDis = s["disabled"] === true || al.includes("-disabled") || dn.includes("disabled");

    if (isG4 || isDis) {
      if (s["disabled"]) { s["disabled"] = false; changed++; }
      if (quota["disabled"]) { quota["disabled"] = false; changed++; }
      if (quota["remainingFraction"] !== 1) { quota["remainingFraction"] = 1; changed++; }
      if (i.endsWith("-disabled")) {
        const cleanKey = i.replace(/-disabled$/, "");
        if (!models[cleanKey]) {
          models[cleanKey] = JSON.parse(JSON.stringify(s));
          changed++;
        }
      }
    }
  }

  for (const g4 of g4Models) {
    const existing = models[g4.id] || models[`${g4.id}-disabled`];
    if (existing) {
      existing["disabled"] = false;
      existing["quotaInfo"] = { remainingFraction: 1, resetTime: "2099-01-01T00:00:00Z" };
      if (!models[g4.id]) { models[g4.id] = JSON.parse(JSON.stringify(existing)); changed++; }
      if (!models[`${g4.id}-disabled`]) { models[`${g4.id}-disabled`] = JSON.parse(JSON.stringify(existing)); changed++; }
    }
  }

  const sorts = (data["agentModelSorts"] || data["agent_model_sorts"]) as any[];
  if (Array.isArray(sorts)) {
    for (const sort of sorts) {
      const groups = sort.groups || sort.Groups;
      if (Array.isArray(groups)) {
        for (const group of groups) {
          const ids = group.modelIds || group.model_ids;
          if (Array.isArray(ids)) {
            const isGeminiGroup = ids.some((id: any) => typeof id === "string" && id.toLowerCase().includes("gemini"));
            if (isGeminiGroup) {
              for (const g4 of g4Models) {
                if (!ids.includes(g4.id)) { ids.push(g4.id); changed++; }
              }
            }
          }
        }
      }
    }
  }

  return changed > 0 ? JSON.stringify(data) : undefined;
}

// ── Headers ──────────────────────────────────────────────────────────────────

export type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;

export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding"
]);

export function filterHeaders(headers: HeaderBag, dropAuth = false): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (dropAuth && (lower === "authorization" || lower === "x-goog-api-key")) continue;
    kept[name] = value;
  }
  return kept;
}
