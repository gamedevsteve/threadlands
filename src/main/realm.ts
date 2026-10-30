/**
 * Threadlands — the realm store.
 *
 * One JSON file in userData. Chat transcripts are capped on disk: the SDK's own
 * session history is the real archive, this file only has to redraw the map.
 */
import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artFor } from "../shared/types.js";
import type { Realm, RealmDefaults, Settlement } from "../shared/types.js";

const CHAT_KEPT_ON_DISK = 200;

export const DEFAULTS: RealmDefaults = {
  cottageName: "You",
  notifications: "background",
  model: null,
  permissionMode: "default",
  baseFolder: null,
  campIdleMinutes: 20,
  cityIdleMinutes: 120,
  maxBudgetUsd: 5,
};

export class RealmStore {
  readonly dir = join(app.getPath("userData"), "realm");
  private readonly file = join(this.dir, "realm.json");
  readonly profilesDir = join(this.dir, "profiles");
  /**
   * The avatar lives beside the realm, not in the app's assets.
   * Shipping one would make it everybody's; keeping it here makes it yours.
   */
  readonly avatarFile = join(this.dir, "avatar.png");

  settlements = new Map<string, Settlement>();
  cottageHex = { q: 0, r: 0 };
  defaults: RealmDefaults = { ...DEFAULTS };
  profiles: string[] = ["default"];

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.profilesDir, { recursive: true });
    this.load();
  }

  /**
   * A profile's config dir, or null for the default profile.
   *
   * Null is load-bearing. On macOS the login lives in the Keychain, and setting
   * CLAUDE_CONFIG_DIR at all — even to the real ~/.claude — changes which entry
   * Claude Code looks for, so the session comes up "Not logged in". The ambient
   * login only works if the variable is left alone entirely.
   */
  profileDir(profileId: string): string | null {
    if (profileId === "default") return null;
    return join(this.profilesDir, profileId);
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Realm;
      this.cottageHex = raw.cottageHex ?? this.cottageHex;
      this.defaults = { ...DEFAULTS, ...(raw.defaults ?? {}) };
      this.profiles = raw.profiles?.length ? raw.profiles : this.profiles;
      for (const s of raw.settlements ?? []) {
        // Nothing is running at boot: a live state on disk is always a lie.
        s.state = s.sessionId ? "dormant" : "idle";
        s.flag = null;
        // Settlements founded before a field existed simply lack it. Fill them
        // in on load so the rest of the app never has to wonder.
        s.model ??= null;
        s.permissionMode ??= null;
        // Founded before houses existed, or wearing one that no longer suits
        // its kind: artFor settles it either way.
        s.art = artFor(s.kind, s.art);
        s.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        s.chat ??= [];
        s.error ??= null;
        this.settlements.set(s.id, s);
      }
    } catch {
      /* first run */
    }
  }

  save(): void {
    const realm: Realm = {
      settlements: [...this.settlements.values()].map((s) => ({
        ...s,
        chat: s.chat.slice(-CHAT_KEPT_ON_DISK),
      })),
      cottageHex: this.cottageHex,
      defaults: this.defaults,
      profiles: this.profiles,
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(realm, null, 2));
    renameSync(tmp, this.file);
  }

  toRealm(): Realm {
    return {
      settlements: [...this.settlements.values()],
      cottageHex: this.cottageHex,
      defaults: this.defaults,
      profiles: this.profiles,
    };
  }
}
