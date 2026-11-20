import { ActionIcon, AppShell, Burger, Button, Center, Group, Loader, NavLink, ScrollArea, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBooks, IconPlus, IconSettings } from "@tabler/icons-react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { useServerEvents, useSettings } from "./api/hooks.ts";
import { lazy, Suspense } from "react";
import { ImportQueueProvider, useImportQueue } from "./components/ImportQueue.tsx";
import { ShelfNav } from "./components/ShelfNav.tsx";
import { AddBooks } from "./pages/AddBooks.tsx";
import { BookDetail } from "./pages/BookDetail.tsx";
import { Library } from "./pages/Library.tsx";
import { ReviewQueue } from "./pages/ReviewQueue.tsx";

/**
 * Readers pull in pdf.js and epub.js. Bun's HTML import currently ships one bundle (no
 * code splitting), so this only defers rendering; it becomes a separate chunk if splitting is enabled.
 */
const Reader = lazy(() => import("./pages/Reader.tsx"));
import { Settings } from "./pages/Settings.tsx";
import { Setup } from "./pages/Setup.tsx";
import { LookupProgress } from "./components/LookupProgress.tsx";

export function App() {
  const settings = useSettings();
  useServerEvents();

  if (settings.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (settings.data && !settings.data.libraryRoot) return <Setup />;

  return (
    <Routes>
      <Route
        path="/read/:id/:hash"
        element={
          <Suspense
            fallback={
              <Center h="100dvh">
                <Loader />
              </Center>
            }
          >
            <Reader />
          </Suspense>
        }
      />
      <Route
        path="*"
        element={
          <ImportQueueProvider>
            <Shell />
          </ImportQueueProvider>
        }
      />
    </Routes>
  );
}

function AddBooksButton() {
  const { open } = useImportQueue();
  return (
    <>
      <Button leftSection={<IconPlus size={16} />} onClick={open} size="sm" visibleFrom="xs">
        Add books
      </Button>
      {/* Phones: icon only, so the header stays on one line. */}
      <ActionIcon onClick={open} size="lg" hiddenFrom="xs" aria-label="Add books">
        <IconPlus size={18} />
      </ActionIcon>
    </>
  );
}

function Shell() {
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
          <IconBooks />
          <Title order={3} style={{ flex: 1 }}>
            Bookshelf
          </Title>
          <AddBooksButton />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <ShelfNav onNavigate={close} />
        </AppShell.Section>
        <AppShell.Section>
          <NavLink
            component={Link}
            to="/settings"
            label="Settings"
            leftSection={<IconSettings size={18} />}
            active={location.pathname === "/settings"}
            onClick={close}
          />
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <LookupProgress />
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/books/:id" element={<BookDetail />} />
          <Route path="/add" element={<AddBooks />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
