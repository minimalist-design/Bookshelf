import { useState } from "react";
import { Alert, Badge, Button, Group, Modal, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useSettings, useUpdateSettings } from "../api/hooks.ts";
import { DirectoryPicker } from "../components/DirectoryPicker.tsx";
import { MaintenancePanel } from "../components/settings/MaintenancePanel.tsx";

const TOOL_LABELS: Record<string, string> = {
  sevenZip: "7z (CBR)",
  unrar: "unrar (CBR)",
  djvused: "djvused (DJVU metadata)",
  ddjvu: "ddjvu (DJVU cover)",
  pdftoppm: "pdftoppm (PDF cover)",
};

export function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [pickRoot, setPickRoot] = useState(false);
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
          {s.libraryRootFromEnv ? (
            <Text size="sm" c="dimmed">
              Set by the BOOKSHELF_LIBRARY_ROOT environment variable.
            </Text>
          ) : (
            <Group>
              <Button variant="default" onClick={() => setPickRoot(true)}>
                Change…
              </Button>
            </Group>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack gap="xs">
          <Title order={4}>Metadata sources</Title>
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
    </Stack>
  );
}
