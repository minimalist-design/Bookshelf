import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { detectExternalTools, ensureDataDirs, loadConfig, type AppConfig, type ExternalTools } from "./config.ts";
import { readConfigFile } from "./configFile.ts";
import { openDatabase } from "./db/index.ts";
import { AliasesRepo } from "./db/repo/aliases.ts";
import { BooksRepo } from "./db/repo/books.ts";
import { HashCacheRepo } from "./db/repo/hashCache.ts";
import { IsbndbRecordsRepo } from "./db/repo/isbndbRecords.ts";
import { SettingsRepo } from "./db/repo/settings.ts";
import { EventBus } from "./events.ts";
import { createExtractor, type Extractor } from "./extract/index.ts";
import { BookService } from "./services/bookService.ts";
import { ImportService } from "./services/importService.ts";
import { ShelfService } from "./services/shelfService.ts";
import { ReaderService } from "./services/readerService.ts";
import { MaintenanceService } from "./services/maintenanceService.ts";
import { LookupService } from "./services/lookupService.ts";
import { CleanupService } from "./services/cleanupService.ts";
import { IsbndbCoverDownloader } from "./services/isbndbCovers.ts";
import { HttpClient, isbndbLimit, type HttpClientOptions } from "./sources/http.ts";
import { CoverStore } from "./covers/store.ts";
import { Library, type LibraryOptions } from "./library/library.ts";
import { ReferenceStore } from "./reference/store.ts";

export interface AppContext {
  config: AppConfig;
  db: Database;
  settings: SettingsRepo;
  books: BooksRepo;
  aliases: AliasesRepo;
  hashCache: HashCacheRepo;
  tools: ExternalTools;
  events: EventBus;
  covers: CoverStore;
  extract: Extractor;
  library: Library;
  importer: ImportService;
  bookService: BookService;
  shelfService: ShelfService;
  http: HttpClient;
  /** Every record ISBNdb has sent, kept for good. */
  isbndbRecords: IsbndbRecordsRepo;
  /** Downloads the kept records' cover images. */
  isbndbCovers: IsbndbCoverDownloader;
  lookup: LookupService;
  reader: ReaderService;
  maintenance: MaintenanceService;
  cleanup: CleanupService;
  /** Imported reference files (authors and books from Wikidata and other sources), apart from the library database. */
  reference: ReferenceStore;
  /** Effective library root: config file override, else the stored setting. */
  libraryRoot(): string | null;
}

export interface CreateAppOptions {
  library?: Partial<LibraryOptions>;
  http?: HttpClientOptions;
}

export function createApp(config: AppConfig = loadConfig(readConfigFile()), options: CreateAppOptions = {}): AppContext {
  ensureDataDirs(config);
  const db = openDatabase(config.dbPath);
  const settings = new SettingsRepo(db);
  const books = new BooksRepo(db);
  const aliases = new AliasesRepo(db);
  const hashCache = new HashCacheRepo(db);
  const tools = detectExternalTools();
  const events = new EventBus();
  const covers = new CoverStore(config.coversDir);
  const extract = createExtractor(tools);
  const library = new Library(
    {
      books,
      hashCache,
      extract,
      events,
      // Store the embedded cover for new books, or for an existing book that has none yet.
      onLinkedNew: async (bookId, { preferred }, embedded) => {
        const book = books.get(bookId);
        if (!embedded.loadCover || !book) return;
        // Keep an existing cover unless this file is the better source and the cover is merely embedded.
        if (book.hasCover && !(preferred && book.coverSource === "embedded")) return;
        const image = await embedded.loadCover();
        if (image && (await covers.save(bookId, image))) {
          books.setHasCover(bookId, true, "embedded");
          events.libraryChanged([bookId]);
        }
      },
      onBooksDeleted: (ids) => covers.removeMany(ids),
      canonicalize: (m) => aliases.apply(m),
    },
    options.library,
  );
  const http = new HttpClient(db, () => settings.get("contactEmail"), {
    ...options.http,
    // ISBNdb is listed (and paced, and held to its daily quota) only when its key is set.
    hostLimits: { ...(config.isbndb.apiKey ? isbndbLimit(config.isbndb) : {}), ...options.http?.hostLimits },
  });
  const bookService = new BookService({ library, books, hashCache, covers, extract, events });
  const isbndbRecords = new IsbndbRecordsRepo(db);
  const isbndbCovers = new IsbndbCoverDownloader({ records: isbndbRecords, http, dir: join(config.dataDir, "isbndb-covers") });
  // New records start their cover downloads; ones left from before a restart carry on now.
  isbndbRecords.onStored = () => isbndbCovers.kick();
  isbndbCovers.kick();
  const lookup = new LookupService({ db, http, library, books, aliases, bookService, covers, events, isbndb: config.isbndb, isbndbRecords, isbndbCovers });
  return {
    config,
    db,
    settings,
    books,
    aliases,
    hashCache,
    tools,
    events,
    covers,
    extract,
    library,
    importer: new ImportService({ library, books, hashCache, extract, events, maxUploadBytes: config.maxUploadBytes }),
    bookService,
    http,
    isbndbRecords,
    isbndbCovers,
    lookup,
    reader: new ReaderService({ library, books, tools }),
    maintenance: new MaintenanceService({ config, db, library, books, covers, bookService, events }),
    cleanup: new CleanupService({ library, books, hashCache, aliases, http, events }),
    shelfService: new ShelfService({ library, hashCache, events }),
    reference: new ReferenceStore(config.dataDir, config.maxUploadBytes),
    libraryRoot: () => config.configLibraryRoot ?? settings.get("libraryRoot"),
  };
}
