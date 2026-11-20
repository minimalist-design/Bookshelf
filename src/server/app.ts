import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { detectExternalTools, ensureDataDirs, loadConfig, type AppConfig, type ExternalTools } from "./config.ts";
import { readConfigFile } from "./configFile.ts";
import { openDatabase } from "./db/index.ts";
import { createAliases, type Aliases } from "./db/repo/aliases.ts";
import * as bookRepo from "./db/repo/books.ts";
import * as isbndbRecords from "./db/repo/isbndbRecords.ts";
import * as settingsRepo from "./db/repo/settings.ts";
import { createEventBus, type EventBus } from "./events.ts";
import { createHealth } from "./api/health.ts";
import { createExtractor, type Extractor } from "./extract/index.ts";
import { createImporter, type Importer } from "./services/importService.ts";
import { createLookupWorker, type LookupWorker } from "./services/lookup/worker.ts";
import { createCoverDownloader, type CoverDownloader } from "./services/isbndbCovers.ts";
import { createHttpClient, isbndbLimit, type HttpClient, type HttpClientOptions } from "./sources/http.ts";
import type { IsbndbStore } from "./sources/isbndb.ts";
import * as coverStore from "./covers/store.ts";
import { createLibrary, type Library, type LibraryOptions } from "./library/library.ts";
import { cleanIncoming } from "./reference/store.ts";

/**
 * Everything the server shares: configuration, the database, and the parts that hold state
 * (library index and watcher, HTTP pacing, background workers). Service modules are plain
 * functions that take the parts they need from it.
 */
export interface AppContext {
  config: AppConfig;
  db: Database;
  aliases: Aliases;
  tools: ExternalTools;
  events: EventBus;
  /** Answers `/api/health`. */
  health: () => Response;
  extract: Extractor;
  library: Library;
  importer: Importer;
  http: HttpClient;
  /** Every record ISBNdb has sent, kept for good; storing records starts their cover downloads. */
  isbndbStore: IsbndbStore;
  /** Downloads the kept records' cover images. */
  isbndbCovers: CoverDownloader;
  /** Background bulk lookups (the lookup functions themselves are in services/lookup/lookup.ts). */
  lookup: LookupWorker;
  /** Effective library root: config file override, else the stored setting. */
  libraryRoot(): string | null;
}

export interface CreateAppOptions {
  library?: Partial<LibraryOptions>;
  http?: HttpClientOptions;
}

export function createApp(config: AppConfig = loadConfig(readConfigFile()), options: CreateAppOptions = {}): AppContext {
  ensureDataDirs(config);
  cleanIncoming(config.referenceDir);
  const db = openDatabase(config.dbPath);
  const aliases = createAliases(db);
  const tools = detectExternalTools();
  const events = createEventBus();
  const extract = createExtractor(tools);
  const library = createLibrary(
    {
      db,
      extract,
      events,
      // Store the embedded cover for new books, or for an existing book that has none yet.
      onLinkedNew: async (bookId, { preferred }, embedded) => {
        const book = bookRepo.get(db, bookId);
        if (!embedded.loadCover || !book) return;
        // Keep an existing cover unless this file is the better source and the cover is merely embedded.
        if (book.hasCover && !(preferred && book.coverSource === "embedded")) return;
        const image = await embedded.loadCover();
        if (image && (await coverStore.save(config.coversDir, bookId, image))) {
          bookRepo.setHasCover(db, bookId, true, "embedded");
          events.libraryChanged([bookId]);
        }
      },
      onBooksDeleted: (ids) => coverStore.removeMany(config.coversDir, ids),
      canonicalize: (m) => aliases.apply(m),
    },
    options.library,
  );
  const http = createHttpClient(db, () => settingsRepo.get(db, "contactEmail"), {
    ...options.http,
    // ISBNdb is listed (and paced, and held to its daily quota) only when its key is set.
    hostLimits: { ...(config.isbndb.apiKey ? isbndbLimit(config.isbndb) : {}), ...options.http?.hostLimits },
  });
  const isbndbCovers = createCoverDownloader({ db, http, dir: config.isbndbCoversDir });
  const isbndbStore: IsbndbStore = {
    get: (isbn13) => isbndbRecords.get(db, isbn13),
    containing: (word, limit) => isbndbRecords.containing(db, word, limit),
    // New records start their cover downloads.
    putMany: (records, via, isbnOf) => {
      const stored = isbndbRecords.putMany(db, records, via, isbnOf);
      if (stored) isbndbCovers.kick();
      return stored;
    },
  };
  // Cover downloads left from before a restart carry on now.
  isbndbCovers.kick();
  const lookup = createLookupWorker({ db, library, events, http, config, isbndbStore });
  lookup.start();
  return {
    config,
    db,
    aliases,
    tools,
    events,
    health: createHealth(db),
    extract,
    library,
    importer: createImporter({ db, library, extract, events, config }),
    http,
    isbndbStore,
    isbndbCovers,
    lookup,
    libraryRoot: () => config.configLibraryRoot ?? settingsRepo.get(db, "libraryRoot"),
  };
}
