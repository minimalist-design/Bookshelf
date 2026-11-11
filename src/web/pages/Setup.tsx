import { Alert, Container, Paper, Stack, Text, Title } from "@mantine/core";
import { useUpdateSettings } from "../api/hooks.ts";
import { DirectoryPicker } from "../components/DirectoryPicker.tsx";

/** First run: choose the library root directory. */
export function Setup() {
  const update = useUpdateSettings();
  return (
    <Container size="sm" py="xl">
      <Paper withBorder p="lg">
        <Stack>
          <div>
            <Title order={2}>Welcome to Bookshelf</Title>
            <Text c="dimmed" mt="xs">
              Choose the directory that holds your library. Each folder directly inside it becomes a bookshelf; books
              placed directly in it are shown as Unshelved.
            </Text>
          </div>
          {update.isError && <Alert color="red">{update.error.message}</Alert>}
          <DirectoryPicker
            confirmLabel="Use this directory"
            busy={update.isPending}
            onConfirm={(libraryRoot) => update.mutate({ libraryRoot })}
          />
        </Stack>
      </Paper>
    </Container>
  );
}
