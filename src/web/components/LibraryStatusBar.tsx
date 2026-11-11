import { Alert, Group, Progress, Text } from "@mantine/core";
import { useLibraryStatus } from "../api/hooks.ts";

export function LibraryStatusBar() {
  const { data: s } = useLibraryStatus();
  if (!s) return null;
  if (s.state === "unavailable") {
    return (
      <Alert color="red" title="Library unavailable">
        {s.message}
      </Alert>
    );
  }
  return (
    <>
      {s.state === "scanning" && (
        <Group gap="sm" wrap="nowrap">
          <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            Scanning {s.scan ? `${s.scan.done} / ${s.scan.total}` : "…"}
          </Text>
          <Progress style={{ flex: 1 }} value={s.scan && s.scan.total ? (100 * s.scan.done) / s.scan.total : 0} animated />
        </Group>
      )}
      {s.message && s.state !== "scanning" && (
        <Alert color="yellow" variant="light">
          {s.message}
        </Alert>
      )}
    </>
  );
}
