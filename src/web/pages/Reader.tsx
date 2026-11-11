import { Button, Center, Loader, Stack, Text } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { useBook } from "../api/hooks.ts";
import { EpubReader } from "../components/reader/EpubReader.tsx";
import { downloadUrl } from "../components/reader/fileUrls.ts";
import { PageReader } from "../components/reader/PageReader.tsx";
import { PdfReader } from "../components/reader/PdfReader.tsx";

/** Full-screen reader for one file of a book (rendered outside the app shell). */
export default function Reader() {
  const { id, hash } = useParams();
  const bookId = Number(id);
  const book = useBook(Number.isFinite(bookId) ? bookId : null);
  const navigate = useNavigate();
  const back = () => navigate(`/books/${bookId}`);

  if (book.isLoading) {
    return (
      <Center h="100dvh">
        <Loader />
      </Center>
    );
  }
  const file = book.data?.files.find((f) => f.hash === hash);
  if (!book.data || !file) {
    return (
      <Center h="100dvh">
        <Stack align="center">
          <Text>This file is no longer in the library.</Text>
          <Button variant="default" onClick={() => navigate("/")}>
            Back to library
          </Button>
        </Stack>
      </Center>
    );
  }
  const props = { book: book.data, hash: file.hash, onBack: back };
  switch (file.format) {
    case "epub":
      return <EpubReader {...props} />;
    case "pdf":
      return <PdfReader {...props} />;
    case "cbz":
    case "cbr":
    case "djvu":
      return <PageReader {...props} />;
    default:
      return (
        <Center h="100dvh">
          <Stack align="center">
            <Text>{file.format.toUpperCase()} files can't be read in the browser yet.</Text>
            <Button component="a" href={downloadUrl(book.data.id, file.hash)}>
              Download {file.filename}
            </Button>
            <Button variant="subtle" onClick={back}>
              Back
            </Button>
          </Stack>
        </Center>
      );
  }
}
