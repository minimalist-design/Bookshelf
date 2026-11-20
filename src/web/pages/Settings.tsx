import { useState } from "react";
import { Alert, Badge, Button, Group, Modal, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { useSettings, useUpdateSettings } from "../api/hooks.ts";
import type { SettingsDto } from "../../shared/types.ts";
import { DirectoryPicker } from "../components/DirectoryPicker.tsx";
import { CleanupPanel } from "../components/settings/CleanupPanel.tsx";
import { SwapPanel } from "../components/settings/SwapPanel.tsx";
import { MaintenancePanel } from "../components/settings/MaintenancePanel.tsx";
import { ReferencePanel } from "../components/settings/ReferencePanel.tsx";

const TOOL_LABELS: Record<string, string> = {
  sevenZip: "7z (CBR)",
  unrar: "unrar (CBR)",
  djvused: "djvused (DJVU metadata)",
  ddjvu: "ddjvu (DJVU cover)",
  pdftoppm: "pdftoppm (PDF cover)",
};

const count = new Intl.NumberFormat();

/** Whether ISBNdb is used, its limits from the config file, and the plan and quota ISBNdb reports for the key. */
function IsbndbStatus({ isbndb }: { isbndb: SettingsDto["isbndb"] }) {
  const key = useQuery({ queryKey: ["isbndbKey"], queryFn: api.isbndbKey, enabled: isbndb.configured, retry: false, staleTime: 60_000 });
  const limits = `${count.format(isbndb.dailyLimit)} calls a day, ${isbndb.perSecond} per second`;
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Text fw={600}>ISBNdb</Text>
        <Badge variant="light" color={isbndb.configured ? "teal" : "gray"}>
          {isbndb.configured ? "In use" : "Not set up"}
        </Badge>
      </Group>
      {isbndb.configured ? (
        <>
          <Text size="sm">
            Asked only when ISBNdb is picked in a lookup's search form; automatic and bulk lookups read the ISBNdb records already
            kept, at no cost. Limits from the config file: {limits}.
          </Text>
          {key.isLoading ? (
            <Text size="sm" c="dimmed">
              Checking the key…
            </Text>
          ) : key.isError ? (
            <Text size="sm" c="red">
              {key.error.message}
            </Text>
          ) : key.data ? (
            <Text size="sm" c="dimmed">
              ISBNdb reports: {key.data.planName} plan · {count.format(key.data.left)} of {count.format(key.data.total)} calls left today.
            </Text>
          ) : null}
        </>
      ) : (
        <Text size="sm" c="dimmed">
          Set <code>ISBNDB_API_KEY</code> in the service's env file (by default <code>~/.secrets/bookshelf.env</code>) and restart Bookshelf to be able
          to search ISBNdb from a lookup's search form.
        </Text>
      )}
    </Stack>
  );
}

export function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const navigate = useNavigate();
  const [pickRoot, setPickRoot] = useState(false);
  const [removeRoot, setRemoveRoot] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const s = settings.data;
  if (!s) return null;

  return (
    <Stack maw={860} pb="xl">
      <Title order={2}>Settings</Title>

      <Paper withBorder p="md">
        <Stack gap="xs">
          <Title order={4}>Library root</Title>
          <Text ff="monospace">{s.libraryRoot}</Text>
          {s.libraryRootFromConfig ? (
            <Text size="sm" c="dimmed">
              Set by library_root in the config file.
            </Text>
          ) : (
            <Group>
              <Button variant="default" onClick={() => setPickRoot(true)}>
                Change…
              </Button>
              <Button variant="light" color="red" onClick={() => setRemoveRoot(true)}>
                Remove library…
              </Button>
            </Group>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack gap="xs">
          <Title order={4}>Metadata sources</Title>
          <IsbndbStatus isbndb={s.isbndb} />
          <Text fw={600} mt="sm">
            Open Library and Crossref
          </Text>
          <Text size="sm" c="dimmed">
            Optional contact email sent to Open Library and Crossref with lookups (gives access to Crossref's faster
            "polite" pool). Leave empty to send none.
          </Text>
          <Group align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              label="Contact email"
              value={email ?? s.contactEmail ?? ""}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
            <Button
              loading={update.isPending}
              disabled={email === null}
              onClick={() =>
                update.mutate(
                  { contactEmail: email },
                  {
                    onSuccess: () => {
                      setEmail(null);
                      notifications.show({ message: "Saved" });
                    },
                    onError: (e) => notifications.show({ color: "red", message: e.message }),
                  },
                )
              }
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Paper>

      <ReferencePanel />

      <Paper withBorder p="md">
        <Stack gap="xs">
          <Title order={4}>External tools</Title>
          <Text size="sm" c="dimmed">
            Optional programs used for extra formats. Without them, those files are still listed using their filename.
          </Text>
          <Group gap="xs">
            {Object.entries(s.tools).map(([key, ok]) => (
              <Badge key={key} color={ok ? "teal" : "gray"} variant={ok ? "light" : "outline"}>
                {TOOL_LABELS[key] ?? key}: {ok ? "found" : "missing"}
              </Badge>
            ))}
          </Group>
        </Stack>
      </Paper>

      <CleanupPanel />
      <SwapPanel />
      <MaintenancePanel />

      <Text size="xs" c="dimmed">
        Data directory: {s.dataDir}
      </Text>

      <Modal opened={pickRoot} onClose={() => setPickRoot(false)} title="Choose library root" size="lg">
        {update.isError && (
          <Alert color="red" mb="sm">
            {update.error.message}
          </Alert>
        )}
        <DirectoryPicker
          initialPath={s.libraryRoot ?? undefined}
          confirmLabel="Use this directory"
          busy={update.isPending}
          onConfirm={(libraryRoot) => update.mutate({ libraryRoot }, { onSuccess: () => setPickRoot(false) })}
        />
      </Modal>

      <Modal opened={removeRoot} onClose={() => setRemoveRoot(false)} title="Remove library">
        <Stack>
          {update.isError && <Alert color="red">{update.error.message}</Alert>}
          <Text size="sm">
            Bookshelf will stop using <Text span ff="monospace">{s.libraryRoot}</Text>. No files or folders are deleted;
            you can choose a library directory again right after, as on first start.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoveRoot(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={update.isPending}
              // Leave /settings so that linking a new library lands on the library view.
              onClick={() => update.mutate({ libraryRoot: null }, { onSuccess: () => navigate("/", { replace: true }) })}
            >
              Remove library
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
