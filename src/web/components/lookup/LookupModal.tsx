import { useEffect, useState } from "react";
import { Modal, Stack } from "@mantine/core";
import type { BookSummaryDto } from "../../../shared/types.ts";
import { AUTO_QUERY, LookupResults, LookupSearchForm, type LookupQuery } from "./LookupSearch.tsx";

/** Look up one book: automatic (by ISBN/DOI, else title search) or a manual query. */
export function LookupModal({ book, opened, onClose }: { book: BookSummaryDto; opened: boolean; onClose: () => void }) {
  const [query, setQuery] = useState<LookupQuery>(AUTO_QUERY);

  useEffect(() => {
    if (opened) setQuery(AUTO_QUERY);
  }, [opened, book.id]);

  return (
    <Modal opened={opened} onClose={onClose} title={`Look up “${book.title}”`} size="70rem">
      {opened && (
        <Stack>
          <LookupSearchForm onSearch={setQuery} />
          <LookupResults book={book} query={query} onApplied={onClose} />
        </Stack>
      )}
    </Modal>
  );
}
