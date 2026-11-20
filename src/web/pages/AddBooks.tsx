import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconAlertTriangle, IconCheck, IconCloudSearch, IconCopy, IconRefresh, IconUpload, IconX } from "@tabler/icons-react";
import { Link } from "react-router";
import type { LookupJobDto, LookupQueueStatus, MetadataServiceUsage } from "../../shared/types.ts";
import { useLookupStatus, useMetadataUsage, useShelves } from "../api/hooks.ts";
import { ACTIVE_STATES, UNSHELVED, useImportQueue, type QueueItem } from "../components/ImportQueue.tsx";

const number = new Intl.NumberFormat();
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Drop or choose files, follow each one through upload and metadata lookup, and watch API usage. */
export function AddBooks() {
  const q = useImportQueue();
  const usage = useMetadataUsage(q.session.start);
  const lookup = useLookupStatus();
  const shelves = useShelves();
  const left = q.items.filter((i) => ACTIVE_STATES.includes(i.state)).length;
  const finished = q.items.length - left;
  const shelfOptions = [
    { value: UNSHELVED, label: "Unshelved (library root)" },
    ...(shelves.data ?? []).filter((s) => s.name !== null).map((s) => ({ value: s.name!, label: s.name! })),
  ];

  return (
    <Stack maw={1200}>
      <div>
        <Title order={2}>Add books</Title>
        <Text c="dimmed" size="sm">
          Files are copied into the library; the originals stay untouched. Counts are for this browser tab.
        </Text>
      </div>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <StatCard label="Added" value={q.session.added} color="teal" />
        <StatCard label="Duplicates" value={q.session.duplicates} color="yellow" />
        <StatCard label="Failed" value={q.session.failed} color="red" />
        <StatCard label="Left" value={left} />
      </SimpleGrid>

      <div>
        <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="sm">
          {usage.data?.services.map((s) => <ApiCard key={s.host} s={s} />)}
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt={6}>
          Metadata API calls (cache hits aren't calls). Limits are each service's published rate, counted over the last hour;
          ISBNdb's is its daily quota (it is asked only when picked in a lookup's search form).
          {usage.data && !usage.data.identified && (
            <>
              {" "}
              Set a contact email in{" "}
              <Anchor component={Link} to="/settings" size="xs">
                Settings
              </Anchor>{" "}
              to raise Open Library's and Crossref's to 3 per second.
            </>
          )}
        </Text>
      </div>

      <Group align="stretch" gap="sm">
        <Dropzone onDrop={(files) => q.addFiles(files)} style={{ flex: 1, minWidth: 260 }} p="sm">
          <Group justify="center" gap="md" mih={64} style={{ pointerEvents: "none" }}>
            <Dropzone.Idle>
              <IconUpload size={32} stroke={1.5} />
            </Dropzone.Idle>
            <Dropzone.Accept>
              <IconCheck size={32} stroke={1.5} />
            </Dropzone.Accept>
            <div>
              <Text>Drag books here or click to choose files</Text>
              <Text size="xs" c="dimmed">
                EPUB, PDF, CBZ, CBR, DJVU, FB2
              </Text>
            </div>
          </Group>
        </Dropzone>
        <Stack gap="xs" w={{ base: "100%", sm: 280 }} justify="center">
          <Select
            label="Add to bookshelf"
            data={shelfOptions}
            value={q.shelf}
            onChange={(v) => v && q.setShelf(v)}
            allowDeselect={false}
            size="xs"
          />
          <Switch
            label="Look up metadata for new books"
            description="Results go to the review queue"
            checked={q.autoLookup}
            onChange={(e) => q.setAutoLookup(e.currentTarget.checked)}
            size="xs"
          />
        </Stack>
      </Group>

      <Group justify="space-between">
        <Title order={4}>Queue ({q.items.length})</Title>
        <Button size="xs" variant="subtle" disabled={!finished} onClick={q.clearFinished}>
          Clear finished
        </Button>
      </Group>
      {q.items.length === 0 ? (
        <Text c="dimmed" size="sm" ta="center" py="lg">
          Nothing in the queue. Added books leave the list once they're in the library
          {q.autoLookup ? " and their metadata has been looked up" : ""}.
        </Text>
      ) : (
        <Stack gap="xs">
          {q.items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              job={item.result ? q.jobs[item.result.bookId] : undefined}
              status={lookup.data}
              onDismiss={() => q.dismiss(item.id)}
              onRetry={() => q.retry(item.id)}
              onRetryLookup={() => q.retryLookup(item.id)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Paper withBorder p="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={value && color ? color : undefined}>
        {number.format(value)}
      </Text>
    </Paper>
  );
}

function ApiCard({ s }: { s: MetadataServiceUsage }) {
  const ratio = s.hourLimit ? s.lastHour / s.hourLimit : 0;
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="sm" fw={600} truncate>
          {s.name}
        </Text>
        {s.coolingDownUntil && (
          <Badge color="yellow" variant="light" size="sm" style={{ flexShrink: 0 }}>
            Cooling down until {clock(s.coolingDownUntil)}
          </Badge>
        )}
      </Group>
      <Group gap={6} align="baseline">
        <Text size="xl" fw={700}>
          {number.format(s.calls)}
        </Text>
        <Text size="xs" c="dimmed">
          this session
        </Text>
      </Group>
      {s.dailyLimit ? (
        <DailyQuota s={s} />
      ) : s.hourLimit ? (
        <>
          <Progress value={Math.min(100, ratio * 100)} size="sm" mt={4} color={ratio > 0.8 ? "orange" : undefined} aria-label={`${s.name}: share of the hourly limit used`} />
          <Text size="xs" c="dimmed" mt={4}>
            {number.format(s.lastHour)} / {number.format(s.hourLimit)} in the last hour · {number.format(Math.max(0, s.hourLimit - s.lastHour))} left ({s.perSecond}/s)
          </Text>
        </>
      ) : (
        <Text size="xs" c="dimmed" mt={4}>
          {number.format(s.lastHour)} in the last hour · no published limit
        </Text>
      )}
    </Paper>
  );
}

/** A service with a daily quota (ISBNdb): today's calls against it, and what the service itself reports. */
function DailyQuota({ s }: { s: MetadataServiceUsage }) {
  const limit = s.dailyLimit!;
  const left = Math.min(Math.max(0, limit - s.today), s.reportedLeft ?? Infinity);
  const ratio = (limit - left) / limit;
  return (
    <>
      <Progress value={Math.min(100, ratio * 100)} size="sm" mt={4} color={ratio > 0.8 ? "orange" : undefined} aria-label={`${s.name}: share of today's limit used`} />
      <Text size="xs" c="dimmed" mt={4}>
        {number.format(s.today)} / {number.format(limit)} today · {number.format(left)} left
        {s.quotaResetsAt ? ` · resets ${clock(s.quotaResetsAt)}` : ""} ({s.perSecond}/s)
      </Text>
      {s.reportedLeft !== null && s.reportedLeft < limit - s.today && (
        <Text size="xs" c="dimmed">
          {s.name} reports {number.format(s.reportedLeft)} left: calls made elsewhere with the same key count too.
        </Text>
      )}
    </>
  );
}

function lookupText(bookId: number, job: LookupJobDto | null | undefined, status: LookupQueueStatus | undefined): string {
  if (status?.currentBookId === bookId) return "Looking up metadata…";
  if (status?.pausedUntil) return `Waiting for metadata lookup · paused: ${status.pausedBy ?? "a service"} is cooling down until ${clock(status.pausedUntil)}`;
  if (status?.waitingForLibrary) return "Waiting for metadata lookup · the library is scanning";
  return `Waiting for metadata lookup${job?.state === "pending" ? ` (#${job.position + 1} in line)` : ""}`;
}

function QueueRow({
  item,
  job,
  status,
  onDismiss,
  onRetry,
  onRetryLookup,
}: {
  item: QueueItem;
  job: LookupJobDto | null | undefined;
  status: LookupQueueStatus | undefined;
  onDismiss: () => void;
  onRetry: () => void;
  onRetryLookup: () => void;
}) {
  const r = item.result;
  const failed = item.state === "error" || item.state === "rejected" || item.state === "lookup-failed";
  const Icon = item.state === "duplicate" ? IconCopy : failed ? IconAlertTriangle : item.state === "lookup" ? IconCloudSearch : IconUpload;
  const color = item.state === "duplicate" ? "yellow" : failed ? "red" : item.state === "lookup" ? "blue" : "gray";
  const busy = item.state === "uploading" && item.progress >= 1;

  let detail: React.ReactNode;
  switch (item.state) {
    case "queued":
      detail = "Waiting to upload";
      break;
    case "uploading":
      detail = busy ? "Processing…" : `${Math.round(item.progress * 100)}% of ${formatSize(item.file.size)}`;
      break;
    case "lookup":
      detail = `Added · ${lookupText(r!.bookId, job, status)}`;
      break;
    case "duplicate":
      detail = (
        <>
          Already in the library ·{" "}
          <Anchor component={Link} to={`/books/${r!.bookId}`} size="xs">
            {r!.relPath ?? "open the book"}
          </Anchor>
        </>
      );
      break;
    case "lookup-failed":
      detail = `Added, but the metadata lookup failed: ${item.error}`;
      break;
    default:
      detail = item.error;
  }

  return (
    <Paper withBorder p="xs">
      <Group wrap="nowrap" align="flex-start" gap="sm">
        <ThemeIcon variant="light" color={color} size="lg">
          <Icon size={18} />
        </ThemeIcon>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>
            {r?.title || item.file.name}
            {r && r.authors.length > 0 && (
              <Text span size="sm" c="dimmed" fw={400}>
                {` · ${r.authors.join(", ")}`}
              </Text>
            )}
          </Text>
          <Text size="xs" c={failed ? "red" : "dimmed"} truncate>
            {detail}
          </Text>
          {(item.state === "uploading" || item.state === "queued") && (
            <Progress value={item.progress * 100} size="sm" animated={busy} aria-label={`Upload of ${item.file.name}`} />
          )}
          {item.state === "lookup" && status?.currentBookId === r?.bookId && <Progress value={100} size="sm" animated aria-label="Looking up metadata" />}
        </Stack>
        {item.state === "error" && (
          <Button size="compact-xs" variant="light" leftSection={<IconRefresh size={12} />} onClick={onRetry}>
            Retry
          </Button>
        )}
        {item.state === "lookup-failed" && (
          <Button size="compact-xs" variant="light" leftSection={<IconRefresh size={12} />} onClick={onRetryLookup}>
            Retry lookup
          </Button>
        )}
        {!ACTIVE_STATES.includes(item.state) && (
          <Tooltip label="Remove from list">
            <ActionIcon variant="subtle" color="gray" onClick={onDismiss} aria-label="Remove from list">
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Paper>
  );
}
