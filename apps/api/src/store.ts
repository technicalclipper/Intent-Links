/**
 * Storage, behind one interface with two implementations.
 *
 * Everything was in-memory Maps, which is fine on a laptop and fatal on Cloud
 * Run: the instance scales to zero and every published link dies with it. A
 * judge opening a submitted link a week later would get a 404, and the
 * creator would have no idea why.
 *
 * The interface is async throughout even where the memory implementation has
 * no reason to be. Making it sync and retrofitting await later would mean
 * touching every call site twice.
 */

import type { Policy } from "@intentlink/schema";
import type { AuditEntry, TokenStore } from "@intentlink/policy";
import { MemoryTokenStore, appendEntry } from "@intentlink/policy";
import { readFile, writeFile } from "node:fs/promises";
import type { PublishedLink } from "./publish.js";

/** Budget counters the engine needs for its per-execution limits. */
export interface Counters {
  actionsUsed: number;
  actionsInLastMinute: number;
}

export interface Store {
  getPolicy(id: string): Promise<Policy | undefined>;
  putPolicy(policy: Policy): Promise<void>;

  getLink(id: string): Promise<PublishedLink | undefined>;
  putLink(link: PublishedLink): Promise<void>;

  /** Pinned at execution start; a later edit must not take effect mid-run. */
  pin(executionId: string, policyHash: string): Promise<void>;
  getPin(executionId: string): Promise<string | undefined>;

  /**
   * Append to the hash chain.
   *
   * The store owns this rather than the caller, because the chain's integrity
   * depends on each entry seeing the real current tail - and two requests
   * appending concurrently from a stale tail would fork it.
   */
  append(executionId: string, input: Parameters<typeof appendEntry>[1]): Promise<AuditEntry>;
  getAudit(executionId: string): Promise<AuditEntry[]>;

  /** Record an action and return the counters the engine should see. */
  countAction(executionId: string, atMs: number): Promise<Counters>;
  getCounters(executionId: string, atMs: number): Promise<Counters>;

  tokens: TokenStore;
}

/* --------------------------------- memory --------------------------------- */

export class MemoryStore implements Store {
  readonly tokens: TokenStore = new MemoryTokenStore();

  protected readonly policies = new Map<string, Policy>();
  protected readonly links = new Map<string, PublishedLink>();
  protected readonly pins = new Map<string, string>();
  private readonly audit = new Map<string, AuditEntry[]>();
  private readonly actions = new Map<string, number[]>();

  async getPolicy(id: string): Promise<Policy | undefined> {
    return this.policies.get(id);
  }
  async putPolicy(policy: Policy): Promise<void> {
    this.policies.set(policy.id, policy);
  }
  async getLink(id: string): Promise<PublishedLink | undefined> {
    return this.links.get(id);
  }
  async putLink(link: PublishedLink): Promise<void> {
    this.links.set(link.id, link);
  }
  async pin(executionId: string, policyHash: string): Promise<void> {
    this.pins.set(executionId, policyHash);
  }
  async getPin(executionId: string): Promise<string | undefined> {
    return this.pins.get(executionId);
  }

  async append(
    executionId: string,
    input: Parameters<typeof appendEntry>[1],
  ): Promise<AuditEntry> {
    const log = this.audit.get(executionId) ?? [];
    const entry = appendEntry(log.at(-1), input);
    this.audit.set(executionId, [...log, entry]);
    return entry;
  }
  async getAudit(executionId: string): Promise<AuditEntry[]> {
    return this.audit.get(executionId) ?? [];
  }

  async countAction(executionId: string, atMs: number): Promise<Counters> {
    const times = this.actions.get(executionId) ?? [];
    times.push(atMs);
    this.actions.set(executionId, times);
    return this.summarize(times, atMs);
  }
  async getCounters(executionId: string, atMs: number): Promise<Counters> {
    return this.summarize(this.actions.get(executionId) ?? [], atMs);
  }

  /**
   * What is worth keeping across a restart.
   *
   * Policies, links and pins only. Audit entries and action counts belong to
   * a run in flight, and a run does not survive the service restarting
   * anyway.
   */
  protected snapshot(): Snapshot {
    return {
      policies: [...this.policies.values()],
      links: [...this.links.values()],
      pins: [...this.pins.entries()],
    };
  }

  protected hydrate(snapshot: Snapshot): void {
    for (const policy of snapshot.policies ?? []) this.policies.set(policy.id, policy);
    for (const link of snapshot.links ?? []) this.links.set(link.id, link);
    for (const [id, hash] of snapshot.pins ?? []) this.pins.set(id, hash);
  }

  /** The rolling window is derived, so nothing has to be swept. */
  private summarize(times: number[], atMs: number): Counters {
    const cutoff = atMs - 60_000;
    return {
      actionsUsed: times.length,
      actionsInLastMinute: times.filter((t) => t >= cutoff).length,
    };
  }
}

/* ----------------------------------- file ---------------------------------- */

/**
 * MemoryStore that survives a restart, for local development.
 *
 * The API runs under --watch so a fix is live the moment it is built, and
 * every restart emptied the store: a published link stopped existing
 * mid-run, and the receiver got "policy service refused the request (404)"
 * with no hint that the cause was a file save. Durable storage in production
 * is Firestore; this is the same need on a laptop, without credentials.
 *
 * Writes are whole-file and synchronous-ish on purpose. The dev dataset is a
 * handful of links, and a crash-safe incremental format would be more
 * machinery than the problem deserves.
 */
export class FileStore extends MemoryStore {
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileStore> {
    const store = new FileStore(path);
    try {
      const raw = await readFile(path, "utf8");
      store.hydrate(JSON.parse(raw) as Snapshot);
    } catch {
      // No file yet, or an unreadable one. Starting empty is correct either
      // way; losing a dev link is not worth refusing to boot over.
    }
    return store;
  }

  override async putPolicy(policy: Policy): Promise<void> {
    await super.putPolicy(policy);
    this.persist();
  }
  override async putLink(link: PublishedLink): Promise<void> {
    await super.putLink(link);
    this.persist();
  }
  override async pin(executionId: string, policyHash: string): Promise<void> {
    await super.pin(executionId, policyHash);
    this.persist();
  }

  /** Serialised, so two saves in the same tick cannot interleave. */
  private persist(): void {
    this.writing = this.writing.then(async () => {
      try {
        await writeFile(this.path, JSON.stringify(this.snapshot(), null, 2), "utf8");
      } catch {
        // A dev convenience; an unwritable path is not worth failing a publish.
      }
    });
  }
}

interface Snapshot {
  policies?: Policy[];
  links?: PublishedLink[];
  pins?: Array<[string, string]>;
}

/* -------------------------------- firestore ------------------------------- */

type FirestoreLike = {
  collection(path: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): unknown }>;
      set(data: unknown): Promise<unknown>;
      create(data: unknown): Promise<unknown>;
      collection(path: string): unknown;
    };
  };
  runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
};

/**
 * Firestore-backed store.
 *
 * Typed structurally rather than against the SDK so the package does not need
 * @google-cloud/firestore installed to compile or to run locally - the import
 * happens only when this store is actually selected.
 */
export class FirestoreStore implements Store {
  readonly tokens: TokenStore;

  constructor(private readonly db: FirestoreLike) {
    this.tokens = new FirestoreTokenStore(db);
  }

  static async create(): Promise<FirestoreStore> {
    /*
     * Imported by name at runtime so the package compiles and runs without
     * @google-cloud/firestore present. The local walkthrough must not require
     * a cloud SDK to be installed, and the deployed image is where it is.
     */
    const specifier = "@google-cloud/firestore";
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      Firestore: new () => FirestoreLike;
    };
    return new FirestoreStore(new mod.Firestore());
  }

  private doc(collection: string, id: string) {
    return this.db.collection(collection).doc(id);
  }

  async getPolicy(id: string): Promise<Policy | undefined> {
    const snap = await this.doc("policies", id).get();
    return snap.exists ? (snap.data() as Policy) : undefined;
  }
  async putPolicy(policy: Policy): Promise<void> {
    await this.doc("policies", policy.id).set(policy);
  }
  async getLink(id: string): Promise<PublishedLink | undefined> {
    const snap = await this.doc("links", id).get();
    return snap.exists ? (snap.data() as PublishedLink) : undefined;
  }
  async putLink(link: PublishedLink): Promise<void> {
    await this.doc("links", link.id).set(link);
  }
  async pin(executionId: string, policyHash: string): Promise<void> {
    await this.doc("executions", executionId).set({ policyHash });
  }
  async getPin(executionId: string): Promise<string | undefined> {
    const snap = await this.doc("executions", executionId).get();
    return snap.exists ? (snap.data() as { policyHash?: string }).policyHash : undefined;
  }

  /**
   * Appended in a transaction.
   *
   * Two requests reading the same tail and both appending would fork the
   * chain, and a forked chain fails verification - which would read as
   * tampering rather than as a race.
   */
  async append(
    executionId: string,
    input: Parameters<typeof appendEntry>[1],
  ): Promise<AuditEntry> {
    const ref = this.doc("executions", executionId) as unknown as {
      get(): Promise<{ exists: boolean; data(): unknown }>;
    };
    return this.db.runTransaction(async (tx) => {
      const t = tx as {
        get(r: unknown): Promise<{ exists: boolean; data(): unknown }>;
        set(r: unknown, data: unknown, opts?: unknown): void;
      };
      const snap = await t.get(ref);
      const existing = (snap.exists ? (snap.data() as { audit?: AuditEntry[] }).audit : []) ?? [];
      const entry = appendEntry(existing.at(-1), input);
      t.set(ref, { audit: [...existing, entry] }, { merge: true });
      return entry;
    });
  }

  async getAudit(executionId: string): Promise<AuditEntry[]> {
    const snap = await this.doc("executions", executionId).get();
    return snap.exists ? ((snap.data() as { audit?: AuditEntry[] }).audit ?? []) : [];
  }

  async countAction(executionId: string, atMs: number): Promise<Counters> {
    const ref = this.doc("executions", executionId) as unknown as object;
    return this.db.runTransaction(async (tx) => {
      const t = tx as {
        get(r: unknown): Promise<{ exists: boolean; data(): unknown }>;
        set(r: unknown, data: unknown, opts?: unknown): void;
      };
      const snap = await t.get(ref);
      const times = (snap.exists ? (snap.data() as { actions?: number[] }).actions : []) ?? [];
      const next = [...times, atMs];
      t.set(ref, { actions: next }, { merge: true });
      return rollingCounters(next, atMs);
    });
  }

  async getCounters(executionId: string, atMs: number): Promise<Counters> {
    const snap = await this.doc("executions", executionId).get();
    const times = (snap.exists ? (snap.data() as { actions?: number[] }).actions : []) ?? [];
    return rollingCounters(times, atMs);
  }
}

function rollingCounters(times: number[], atMs: number): Counters {
  const cutoff = atMs - 60_000;
  return {
    actionsUsed: times.length,
    actionsInLastMinute: times.filter((t) => t >= cutoff).length,
  };
}

/**
 * Single-use tokens, enforced across instances.
 *
 * The in-memory store cannot do this once there is more than one Cloud Run
 * instance: a token spent on instance A is unknown to instance B, and the
 * replay protection that the whole authorization model rests on quietly stops
 * working. `create` fails if the document already exists, which is exactly
 * the atomic claim needed.
 */
class FirestoreTokenStore implements TokenStore {
  constructor(private readonly db: FirestoreLike) {}

  async consume(jti: string, expEpochSeconds: number, nowEpochSeconds: number): Promise<boolean> {
    try {
      await this.db
        .collection("spent_tokens")
        .doc(jti)
        .create({ exp: expEpochSeconds, spentAt: nowEpochSeconds });
      return true;
    } catch {
      // Already present: this token has been spent. Firestore TTL on `exp`
      // reclaims these, so the collection does not grow forever.
      return false;
    }
  }
}

/* -------------------------------- selection ------------------------------- */

/**
 * Memory unless Firestore is asked for.
 *
 * Defaulting to Firestore would make the local walkthrough depend on cloud
 * credentials, and defaulting to memory in production would lose every link -
 * so it is an explicit choice, and the deployed config makes it.
 */
export async function createStore(): Promise<Store> {
  if (process.env.INTENTLINK_STORE === "firestore") {
    return FirestoreStore.create();
  }
  // Local default: survive the restarts --watch causes. Pure memory is for
  // tests, which want a clean store per run.
  const path = process.env.INTENTLINK_STORE_FILE ?? ".intentlink-dev.json";
  return FileStore.open(path);
}
