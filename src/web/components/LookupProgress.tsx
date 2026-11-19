import { ActionIcon, Button, Group, Paper, Progress, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCloudSearch, IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { api } from "../api/client.ts";
import { useLookupStatus } from "../api/hooks.ts";

export function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `about ${h} h${m ? ` ${m} min` : ""} left`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Progress of the background metadata lookups, shown on every page while a run is going. */
export function LookupProgress() {
  const { data: s } = useLookupStatus();
  const onReview = useLocation().pathname === "/review";
  const cancel = useMutation({
    mutationFn: api.cancelLookups,
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });
  if (!s?.running) return null;

  const total = s.done + s.pending;
  const paused = !!s.pausedUntil;
  const details = [
    s.noMatch ? `${s.noMatch} without matches` : null,
    s.failed ? `${s.failed} failed` : null,
  ].filter(Boolean);

  return (
    <Paper withBorder p="xs" mb="md" role="status" aria-label="Metadata lookup progress">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconCloudSearch size={18} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" gap="xs" mb={6}>
            <Text size="sm">
              Looking up metadata: {s.done} of {total}
              {details.length ? <Text span size="sm" c="dimmed">{` · ${details.join(" · ")}`}</Text> : null}
            </Text>
            {s.etaSeconds !== null && !s.waitingForLibrary && (
              <Text size="xs" c="dimmed">
                {formatTimeLeft(s.etaSeconds)}
              </Text>
            )}
          </Group>
          <Progress
            value={total ? (100 * s.done) / total : 0}
            animated={!paused && !s.waitingForLibrary}
            color={paused ? "yellow" : undefined}
            aria-label={`${s.done} of ${total} books looked up`}
          />
          {paused && (
            <Text size="xs" c="yellow.8" mt={4}>
              Paused: {s.pausedBy ?? "A metadata service"} asked us to slow down. Resuming at {clock(s.pausedUntil!)}.
            </Text>
          )}
          {s.waitingForLibrary && (
            <Text size="xs" c="dimmed" mt={4}>
              Waiting for the library to finish scanning.
            </Text>
          )}
        </div>
        {!onReview && s.reviewCount > 0 && (
          <Button component={Link} to="/review" size="compact-sm" variant="subtle">
            Review {s.reviewCount}
          </Button>
        )}
        <Tooltip label="Stop looking up the remaining books">
          <ActionIcon variant="subtle" color="gray" loading={cancel.isPending} onClick={() => cancel.mutate()} aria-label="Stop metadata lookups">
            <IconX size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Paper>
  );
}
