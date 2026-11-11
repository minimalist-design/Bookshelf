import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { detectExternalTools } from "../src/server/config.ts";
import { extractCbr, extractCbz } from "../src/server/extract/comic.ts";
import { extractDjvu, parseDjvuMeta } from "../src/server/extract/djvu.ts";
import { extractEpub } from "../src/server/extract/epub.ts";
import { extractFb2 } from "../src/server/extract/fb2.ts";
import { createExtractor } from "../src/server/extract/index.ts";
import { isJunkAuthor, isJunkTitle } from "../src/server/extract/junk.ts";
import { mergeMetadata } from "../src/server/extract/merge.ts";
import { extractPdf } from "../src/server/extract/pdf.ts";
import { htmlToText, normalizeDate } from "../src/server/extract/text.ts";
import { ZipArchive } from "../src/server/extract/zip.ts";
import { parseFilename } from "../src/server/naming/parseFilename.ts";
import { makeEpub, makeFb2, makeJpeg, makePdf, makePng, makeZip, xmpPacket } from "./fixtures.ts";

const tools = detectExternalTools();
const tmp = mkdtempSync(join(tmpdir(), "bookshelf-extract-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function write(name: string, data: Uint8Array | string): string {
  const p = join(tmp, `${n++}-${name}`);
  writeFileSync(p, data);
  return p;
}

async function imageSize(data: Uint8Array | undefined) {
  const m = await sharp(data!).metadata();
  return [m.width, m.height];
}

describe("zip reader", () => {
  test("reads stored and deflated entries, case-insensitive lookup", async () => {
    const big = "x".repeat(100_000);
    const p = write("a.zip", makeZip({ "Dir/Hello.txt": "hello", "big.txt": big }));
    const zip = await ZipArchive.open(p);
    expect(zip.entries.map((e) => e.name).sort()).toEqual(["Dir/Hello.txt", "big.txt"]);
    expect(await zip.readText("dir/hello.TXT")).toBe("hello");
    expect(await zip.readText("big.txt")).toBe(big);
    expect(await zip.readText("missing")).toBeNull();
  });

  test("rejects non-zip files", async () => {
    expect(ZipArchive.open(write("x.zip", "not a zip at all, definitely not"))).rejects.toThrow();
  });
});

describe("EPUB", () => {
  test("EPUB 3: refines, identifiers, series, cover-image, HTML description", async () => {
    const png = await makePng(120, 180);
    const p = write(
      "book.epub",
      makeEpub({
        metadataXml: `
          <dc:title id="t1">The Main Title</dc:title>
          <meta refines="#t1" property="title-type">main</meta>
          <dc:title id="t2">A Subtitle</dc:title>
          <meta refines="#t2" property="title-type">subtitle</meta>
          <dc:creator id="c1">Ursula K. Le Guin</dc:creator>
          <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
          <dc:creator id="c2">Some Illustrator</dc:creator>
          <meta refines="#c2" property="role" scheme="marc:relators">ill</meta>
          <dc:identifier id="uid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>
          <dc:identifier>urn:isbn:978-0-441-17271-9</dc:identifier>
          <dc:identifier>doi:10.1000/epub.test</dc:identifier>
          <dc:publisher>Ace</dc:publisher>
          <dc:date>1990-09-01T00:00:00Z</dc:date>
          <dc:language>EN</dc:language>
          <dc:description>&lt;p&gt;First &amp;amp; best.&lt;/p&gt;&lt;p&gt;Second para.&lt;/p&gt;</dc:description>
          <dc:subject>Science Fiction</dc:subject>
          <dc:subject>Classics</dc:subject>
          <meta property="belongs-to-collection" id="col">Earthsea</meta>
          <meta refines="#col" property="collection-type">series</meta>
          <meta refines="#col" property="group-position">2</meta>`,
        manifestXml: `<item id="img" href="images/cover%20art.png" media-type="image/png" properties="cover-image"/>`,
        files: { "images/cover art.png": png },
      }),
    );
    const m = await extractEpub(p);
    expect(m).toMatchObject({
      title: "The Main Title",
      subtitle: "A Subtitle",
      authors: ["Ursula K. Le Guin"],
      isbn13: "9780441172719",
      doi: "10.1000/epub.test",
      publisher: "Ace",
      publishedDate: "1990-09-01",
      language: "en",
      description: "First & best.\n\nSecond para.",
      tags: ["Science Fiction", "Classics"],
      series: "Earthsea",
      seriesIndex: 2,
    });
    const c = await m.loadCover!();
    expect(c!.mime).toBe("image/png");
    expect(await imageSize(c!.data)).toEqual([120, 180]);
  });

  test("EPUB 2: opf:scheme ISBN, opf:role, calibre series, meta name=cover, placeholder date", async () => {
    const jpg = await makeJpeg(50, 70);
    const p = write(
      "book2.epub",
      makeEpub({
        version: "2.0",
        opfPath: "content.opf",
        metadataXml: `
          <dc:title>Old Style</dc:title>
          <dc:creator opf:role="aut" opf:file-as="Austen, Jane">Jane Austen</dc:creator>
          <dc:creator opf:role="edt">An Editor</dc:creator>
          <dc:identifier opf:scheme="ISBN">0131103628</dc:identifier>
          <dc:date>0101-01-01T00:00:00+00:00</dc:date>
          <meta name="calibre:series" content="Novels"/>
          <meta name="calibre:series_index" content="3.5"/>
          <meta name="cover" content="cov"/>`,
        manifestXml: `<item id="cov" href="c.jpg" media-type="image/jpeg"/>`,
        files: { "c.jpg": jpg },
      }),
    );
    const m = await extractEpub(p);
    expect(m).toMatchObject({ title: "Old Style", authors: ["Jane Austen"], isbn13: "9780131103627", series: "Novels", seriesIndex: 3.5 });
    expect(m.publishedDate).toBeUndefined();
    expect((await m.loadCover!())!.mime).toBe("image/jpeg");
  });
});

describe("PDF", () => {
  test("XMP wins over Info, DOI from metadata, page count", async () => {
    const p = write(
      "paper.pdf",
      makePdf({
        info: { Title: "Info Title", Author: "Info Author", Subject: "Journal of Tests, doi:10.5555/info.doi" },
        xmp: xmpPacket({ title: "Ünïcode XMP Title", creators: ["Ada Lovelace", "Charles Babbage"], doi: "10.1234/xmp.doi" }),
        pages: 3,
      }),
    );
    const m = await extractPdf(p, null);
    expect(m).toMatchObject({ title: "Ünïcode XMP Title", authors: ["Ada Lovelace", "Charles Babbage"], doi: "10.1234/xmp.doi", pages: 3 });
    expect(m.loadCover).toBeUndefined();
  });

  test("Info only: authors string, DOI and ISBN found in Subject/Keywords", async () => {
    const p = write(
      "info.pdf",
      makePdf({ info: { Title: "Info Only", Author: "Jane Doe; John Roe", Subject: "see doi:10.5555/abc.123", Keywords: "ISBN 978-0-13-110362-7" } }),
    );
    const m = await extractPdf(p, null);
    expect(m).toMatchObject({ title: "Info Only", authors: ["Jane Doe; John Roe"], doi: "10.5555/abc.123", isbn13: "9780131103627", pages: 1 });
  });

  test.skipIf(!tools.pdftoppm)("cover rendered from the first page", async () => {
    const m = await extractPdf(write("c.pdf", makePdf({ info: { Title: "X" } })), tools.pdftoppm);
    const c = await m.loadCover!();
    expect(c!.mime).toBe("image/jpeg");
    const [w, h] = await imageSize(c!.data);
    expect(h).toBe(1200);
    expect(w).toBe(800); // 200x300 page scaled to fit 1200
  });

  test("corrupt files yield no metadata instead of throwing", async () => {
    const extract = createExtractor(tools);
    expect(await extract(write("broken.pdf", "%PDF-1.4 garbage"), "pdf")).toEqual({});
    expect(await extract(write("broken.epub", "nope"), "epub")).toEqual({});
  });
});

describe("comics", () => {
  test("CBZ with ComicInfo and FrontCover page", async () => {
    const red = await makePng(30, 40, { r: 255, g: 0, b: 0 });
    const blue = await makePng(31, 41, { r: 0, g: 0, b: 255 });
    const p = write(
      "c.cbz",
      makeZip({
        "ComicInfo.xml": `<?xml version="1.0"?>
          <ComicInfo><Series>Saga</Series><Number>7</Number><Writer>Brian K. Vaughan, Fiona Staples</Writer>
          <Publisher>Image</Publisher><Year>2013</Year><Month>4</Month><Summary>Space opera.</Summary>
          <Genre>Sci-Fi, Fantasy</Genre><LanguageISO>EN</LanguageISO><GTIN>9781607066927</GTIN>
          <Pages><Page Image="0"/><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>`,
        "page10.png": blue,
        "page2.png": red,
        "__MACOSX/._page2.png": "junk",
      }),
    );
    const m = await extractCbz(p);
    expect(m).toMatchObject({
      title: "Saga #7",
      series: "Saga",
      seriesIndex: 7,
      authors: ["Brian K. Vaughan", "Fiona Staples"],
      publisher: "Image",
      publishedDate: "2013-04",
      tags: ["Sci-Fi", "Fantasy"],
      isbn13: "9781607066927",
      language: "en",
    });
    // Natural order is page2, page10; FrontCover is image index 1 → page10 (blue, 31x41).
    expect(await imageSize((await m.loadCover!())!.data)).toEqual([31, 41]);
  });

  test("CBZ without ComicInfo: first page in natural order, page count", async () => {
    const p = write("plain.cbz", makeZip({ "x/p10.jpg": await makeJpeg(20, 20), "x/p9.jpg": await makeJpeg(22, 22), "x/notes.txt": "hi" }));
    const m = await extractCbz(p);
    expect(m.title).toBeUndefined();
    expect(m.pages).toBe(2);
    expect(await imageSize((await m.loadCover!())!.data)).toEqual([22, 22]);
  });

  test("CBR that is really a ZIP is read natively", async () => {
    const p = write("zip.cbr", makeZip({ "ComicInfo.xml": "<ComicInfo><Title>Zipped</Title></ComicInfo>", "1.png": await makePng() }));
    expect((await extractCbr(p, { ...tools, sevenZip: null, unrar: null })).title).toBe("Zipped");
  });

  test.skipIf(!tools.sevenZip)("CBR via 7-Zip (7z archive with a .cbr name)", async () => {
    const dir = mkdtempSync(join(tmp, "cbr-src-"));
    writeFileSync(join(dir, "ComicInfo.xml"), "<ComicInfo><Title>Seven Zipped</Title><Writer>Alan Moore</Writer></ComicInfo>");
    writeFileSync(join(dir, "002.png"), await makePng(40, 60));
    writeFileSync(join(dir, "001 [cover].png"), await makePng(44, 66)); // brackets must not act as wildcards
    const out = join(tmp, "seven.cbr");
    const proc = Bun.spawnSync([tools.sevenZip!, "a", "-t7z", out, "."], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    expect(proc.exitCode).toBe(0);
    const m = await extractCbr(out, tools);
    expect(m).toMatchObject({ title: "Seven Zipped", authors: ["Alan Moore"], pages: 2 });
    expect(await imageSize((await m.loadCover!())!.data)).toEqual([44, 66]);
  });
});

describe("DJVU", () => {
  test("print-meta parsing", () => {
    expect(parseDjvuMeta('title\t"A \\"quoted\\" title"\nAuthor\t"Jane"\nbad line\n')).toEqual({ title: 'A "quoted" title', author: "Jane" });
  });

  test.skipIf(!tools.djvused || !tools.ddjvu || !Bun.which("c44") || !tools.pdftoppm)("metadata, pages and cover", async () => {
    const dir = mkdtempSync(join(tmp, "djvu-"));
    const pdf = join(dir, "p.pdf");
    writeFileSync(pdf, makePdf());
    const sh = (cmd: string[]) => expect(Bun.spawnSync(cmd, { cwd: dir, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    sh([tools.pdftoppm!, "-singlefile", "p.pdf", "page"]);
    sh(["c44", "page.ppm", "book.djvu"]);
    writeFileSync(join(dir, "meta.txt"), 'title\t"Ünïcode Djvu"\nauthor\t"Jane Doe"\nyear\t"1999"\nisbn\t"9780131103627"\n');
    sh([tools.djvused!, "book.djvu", "-e", "set-meta meta.txt", "-s"]);
    const m = await extractDjvu(join(dir, "book.djvu"), tools);
    expect(m).toMatchObject({ title: "Ünïcode Djvu", authors: ["Jane Doe"], publishedDate: "1999", isbn13: "9780131103627", pages: 1 });
    const c = await m.loadCover!();
    expect(c!.mime).toBe("image/jpeg");
    expect((await imageSize(c!.data))[0]).toBeGreaterThan(100);
  });
});

describe("FB2", () => {
  const titleInfo = `
    <genre>sf_fantasy</genre><genre>adventure</genre>
    <author><first-name>Arkady</first-name><last-name>Strugatsky</last-name></author>
    <author><first-name>Boris</first-name><middle-name>N.</middle-name><last-name>Strugatsky</last-name></author>
    <book-title>Roadside Picnic</book-title>
    <annotation><p>First paragraph.</p><p>Second <emphasis>one</emphasis>.</p></annotation>
    <date value="1972-01-01">1972</date>
    <lang>ru</lang>
    <sequence name="Noon Universe" number="4"/>`;

  test("plain FB2 with embedded cover", async () => {
    const png = await makePng(33, 44);
    const p = write("b.fb2", makeFb2({ titleInfo, publishInfo: "<publisher>Macmillan</publisher><year>1977</year><isbn>978-0-02-615170-3</isbn>", coverPng: png }));
    const m = await extractFb2(p);
    expect(m).toMatchObject({
      title: "Roadside Picnic",
      authors: ["Arkady Strugatsky", "Boris N. Strugatsky"],
      tags: ["sf_fantasy", "adventure"],
      description: "First paragraph.\n\nSecond one.",
      language: "ru",
      series: "Noon Universe",
      seriesIndex: 4,
      publisher: "Macmillan",
      publishedDate: "1977",
      isbn13: "9780026151703",
    });
    expect(await imageSize((await m.loadCover!())!.data)).toEqual([33, 44]);
  });

  test("zipped FB2", async () => {
    const p = write("b.fb2.zip", makeZip({ "book.fb2": makeFb2({ titleInfo }) }));
    expect((await extractFb2(p)).title).toBe("Roadside Picnic");
  });

  test("windows-1251 encoded FB2", async () => {
    const xml = makeFb2({ titleInfo: "<book-title>Пикник на обочине</book-title>" }).replace('encoding="UTF-8"', 'encoding="windows-1251"');
    // Encode to cp1251 by hand for the Cyrillic range used here.
    const bytes = Uint8Array.from([...xml].map((ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) return cp;
      if (cp >= 0x410 && cp <= 0x44f) return cp - 0x410 + 0xc0;
      throw new Error(`unmapped ${ch}`);
    }));
    expect((await extractFb2(write("cp1251.fb2", bytes))).title).toBe("Пикник на обочине");
  });
});

describe("merge + junk", () => {
  test("junk detection", () => {
    for (const t of ["untitled", "Microsoft Word - thesis.docx", "Document1", "chapter1.tex", "0a1b2c3d4e5f6a7b8c9d", "123", ""]) {
      expect(isJunkTitle(t)).toBe(true);
    }
    expect(isJunkTitle("Dune")).toBe(false);
    expect(isJunkTitle("my_file", "my_file")).toBe(true);
    expect(isJunkAuthor("Administrator")).toBe(true);
    expect(isJunkAuthor("user123")).toBe(true);
    expect(isJunkAuthor("Frank Herbert")).toBe(false);
  });

  test("field-level merge: embedded wins unless junk; filename IDs always win", () => {
    const parsed = parseFilename("Real Title -- Real Author -- isbn13 9780441172719.pdf");
    const r = mergeMetadata(
      { title: "Microsoft Word - draft.docx", authors: ["Administrator"], isbn13: "9780131103627", publisher: "Pub", tags: ["a", "A", "b"] },
      parsed,
      "Real Title -- Real Author -- isbn13 9780441172719",
    );
    expect(r.metadata).toMatchObject({ title: "Real Title", authors: ["Real Author"], isbn13: "9780441172719", publisher: "Pub", tags: ["a", "b"] });
    expect(r.source).toBe("mixed");

    const r2 = mergeMetadata({ title: "Embedded", authors: ["Kernighan, Brian W.; Ritchie, Dennis M."] }, parseFilename("whatever.epub"), "whatever");
    expect(r2.metadata).toMatchObject({ title: "Embedded", authors: ["Brian W. Kernighan", "Dennis M. Ritchie"] });
    expect(r2.source).toBe("embedded");

    // Title equal to a plain filename is kept (with its proper casing); equal to a structured one is junk.
    expect(mergeMetadata({ title: "Dune" }, parseFilename("dune.epub"), "dune").metadata.title).toBe("Dune");
    expect(mergeMetadata({ title: "Dune -- Frank Herbert" }, parseFilename("Dune -- Frank Herbert.pdf"), "Dune -- Frank Herbert").metadata.title).toBe("Dune");

    const r3 = mergeMetadata({}, parseFilename("Only -- Filename.epub"), "Only -- Filename");
    expect(r3.source).toBe("filename");
  });

  test("text helpers", () => {
    expect(htmlToText("<div>A&nbsp;b<br/>c</div><p>&#x41;&#66;</p>")).toBe("A b\nc\n\nAB");
    expect(normalizeDate("2010-05-01T00:00:00Z")).toBe("2010-05-01");
    expect(normalizeDate("0101-01-01")).toBeNull();
    expect(normalizeDate("circa 1850")).toBe("1850");
  });
});
