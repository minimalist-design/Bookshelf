import type { BookFormat } from "../../../shared/types.ts";

export const fileUrl = (bookId: number, hash: string) => `/api/books/${bookId}/files/${hash}`;
export const downloadUrl = (bookId: number, hash: string) => `${fileUrl(bookId, hash)}?download=1`;
export const pageUrl = (bookId: number, hash: string, n: number) => `${fileUrl(bookId, hash)}/pages/${n}`;
export const readerUrl = (bookId: number, hash: string) => `/read/${bookId}/${hash}`;

/** Formats with an in-browser reader (CBR/DJVU need the optional server tools). */
export const READABLE: readonly BookFormat[] = ["epub", "pdf", "cbz", "cbr", "djvu"];
export const isReadable = (f: BookFormat) => READABLE.includes(f);
