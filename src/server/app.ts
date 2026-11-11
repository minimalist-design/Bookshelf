import type { Database } from "bun:sqlite";
import { detectExternalTools, ensureDataDirs, loadConfig, type AppConfig, type ExternalTools } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { BooksRepo } from "./db/repo/books.ts";
import { HashCacheRepo } from "./db/repo/hashCache.ts";
import { SettingsRepo } from "./db/repo/settings.ts";
import { EventBus } from "./events.ts";
import { createExtractor, type Extractor } from "./extract/index.ts";
import { BookService } from "./services/bookService.ts";
import { ImportService } from "./services/importService.ts";
import { ShelfService } from "./services/shelfService.ts";
import { ReaderService } from "./services/readerService.ts";
import { MaintenanceService } from "./services/maintenanceService.ts";
import { LookupService } from "./services/lookupService.ts";
import { HttpClient, type HttpClientOptions } from "./sources/http.ts";
import { CoverStore } from "./covers/store.ts";
import { Library, type LibraryOptions } from "./library/library.ts";

export interface AppContext {
  config: AppConfig;
  db: Database;
  settings: SettingsRepo;
  books: BooksRepo;
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
  lookup: LookupService;
  reader: ReaderService;
  maintenance: MaintenanceService;
  /** Effective library root: env override, else the stored setting. */
  libraryRoot(): string | null;
}

export interface CreateAppOptions {
  library?: Partial<LibraryOptions>;
  http?: HttpClientOptions;
}

export function createApp(config: AppConfig = loadConfig(), options: CreateAppOptions = {}): AppContext {
  ensureDataDirs(config);
  const db = openDatabase(config.dbPath);
  const settings = new SettingsRepo(db);
  const books = new BooksRepo(db);
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
    },
    options.library,
  );
  const http = new HttpClient(db, () => settings.get("contactEmail"), options.http);
  const bookService = new BookService({ library, books, hashCache, covers, extract, events });
  const lookup = new LookupService({ db, http, library, books, bookService, covers, events });
  return {
    config,
    db,
    settings,
    books,
    hashCache,
    tools,
    events,
    covers,
    extract,
    library,
    importer: new ImportService({ library, books, hashCache, extract, events, maxUploadBytes: config.maxUploadBytes }),
    bookService,
    http,
    lookup,
    reader: new ReaderService({ library, books, tools }),
    maintenance: new MaintenanceService({ config, db, library, books, covers, bookService, events }),
    shelfService: new ShelfService({ library, hashCache, events }),
    libraryRoot: () => config.envLibraryRoot ?? settings.get("libraryRoot"),
  };
}
