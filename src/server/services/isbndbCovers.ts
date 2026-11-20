import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as isbndbRecords from "../db/repo/isbndbRecords.ts";
import type { IsbndbRecord } from "../db/repo/isbndbRecords.ts";
import { HttpError, RateLimitedError, type HttpClient } from "../sources/http.ts";

export interface IsbndbCoverDeps {
  db: Database;
  http: HttpClient;
  /** `<data dir>/isbndb-covers`. */
  dir: string;
}

/** Records taken from the queue at a time. */
const BATCH = 20;
/** `image_original` links expire 2 h after ISBNdb sent them; older ones go straight to `image`. */
const ORIGINAL_LINK_LIFETIME_MS = 2 * 60 * 60 * 1000 - 5 * 60 * 1000;

/** File extension from the image's first bytes; ISBNdb serves JPEG, the rest is just in case. */
function extensionOf(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xd8) return "jpg";
  if (data[0] === 0x89 && data[1] === 0x50) return "png";
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57 && data[9] === 0x45) return "webp";
  if (data[0] === 0x47 && data[1] === 0x49) return "gif";
  return "img";
}

const https = (v: unknown): string | null => (typeof v === "string" && v.startsWith("https://") ? v : null);

/** The links to try, best first: the original while its temporary link is fresh, then the 450 px image. */
export function coverUrls(record: IsbndbRecord, fetchedAt: string, now: number): string[] {
  const fresh = now - Date.parse(fetchedAt) < ORIGINAL_LINK_LIFETIME_MS;
  return [fresh ? https(record.image_original) : null, https(record.image)].filter((u): u is string => !!u);
}

/**
 * Downloads the cover image of every kept ISBNdb record (placeholders included: ISBNdb can't say
 * which ones are) into the data directory, so the copy is complete without ISBNdb. Works in the
 * background, behind interactive requests, at the image host's pace (the downloads cost no API
 * quota). The highest resolution (`image_original`) is tried first while its temporary link is
 * fresh, else the 450 px `image`. Pending covers survive restarts (they are marked in the database).
 */
export interface CoverDownloader {
  /** Start (or keep) working through the records whose cover isn't downloaded yet. */
  kick(): void;
  stop(): void;
  /** Waits until nothing is being downloaded (tests). */
  idle(): Promise<void>;
  /** A downloaded cover's bytes (for applying it to a book without downloading it again). */
  read(isbn13: string): Uint8Array | null;
}

export function createCoverDownloader(deps: IsbndbCoverDeps): CoverDownloader {
  const { db, http, dir } = deps;
  let working = false;
  let stopped = false;

  /** The first of `urls` that answers with an image; an expired original (403/404/410) falls through to the next. */
  const firstImage = async (urls: readonly string[]): Promise<Uint8Array | null> => {
    for (const url of urls) {
      try {
        const data = await http.getBytes(url);
        if (data?.byteLength) return data;
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        if (!(err instanceof HttpError) || url === urls.at(-1)) throw err;
      }
    }
    return null;
  };

  const drain = async (): Promise<void> => {
    if (working || stopped) return;
    working = true;
    try {
      mkdirSync(dir, { recursive: true });
      while (!stopped) {
        const batch = isbndbRecords.pendingCovers(db, BATCH);
        if (!batch.length) break;
        for (const { isbn13, record, fetchedAt } of batch) {
          if (stopped) break;
          const urls = coverUrls(record, fetchedAt, Date.now());
          if (!urls.length) {
            isbndbRecords.setCover(db, isbn13, "none");
            continue;
          }
          try {
            const data = await http.background(() => firstImage(urls));
            if (!data) {
              isbndbRecords.setCover(db, isbn13, "failed");
              continue;
            }
            const file = `${isbn13}.${extensionOf(data)}`;
            writeFileSync(join(dir, file), data);
            isbndbRecords.setCover(db, isbn13, "done", file, data.byteLength);
          } catch (err) {
            // The image host is rate-limiting us: try again once it accepts requests (or at the next kick).
            if (err instanceof RateLimitedError) {
              setTimeout(() => void drain(), Math.max(1000, err.retryAt - Date.now())).unref?.();
              return;
            }
            console.warn(`ISBNdb cover for ${isbn13} not downloaded: ${err instanceof Error ? err.message : String(err)}`);
            isbndbRecords.setCover(db, isbn13, "failed");
          }
        }
      }
    } finally {
      working = false;
    }
  };

  return {
    kick: () => void drain(),
    stop() {
      stopped = true;
    },
    async idle() {
      while (working) await Bun.sleep(10);
    },
    read(isbn13) {
      const file = isbndbRecords.coverFile(db, isbn13);
      if (!file) return null;
      try {
        return new Uint8Array(readFileSync(join(dir, file)));
      } catch {
        return null;
      }
    },
  };
}
