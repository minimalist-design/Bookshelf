import type { ReactNode } from "react";
import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconArrowLeft, IconDownload } from "@tabler/icons-react";

interface Props {
  title: string;
  subtitle?: string;
  onBack: () => void;
  downloadHref: string;
  controls?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}

/** Full-viewport reader layout: slim top bar + content area that fills the rest. */
export function ReaderFrame({ title, subtitle, onBack, downloadHref, controls, status, children }: Props) {
  return (
    <Box h="100dvh" style={{ display: "flex", flexDirection: "column", background: "var(--mantine-color-body)" }}>
      <Group
        h={48}
        px="xs"
        gap="xs"
        wrap="nowrap"
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
      >
        <Tooltip label="Back to book">
          <ActionIcon variant="subtle" onClick={onBack} aria-label="Back to book">
            <IconArrowLeft size={18} />
          </ActionIcon>
        </Tooltip>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600} truncate>
            {title}
          </Text>
          {subtitle && (
            <Text size="xs" c="dimmed" truncate>
              {subtitle}
            </Text>
          )}
        </div>
        {status && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {status}
          </Text>
        )}
        {controls}
        <Tooltip label="Download">
          <ActionIcon variant="subtle" component="a" href={downloadHref} aria-label="Download">
            <IconDownload size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Box style={{ flex: 1, minHeight: 0, position: "relative" }}>{children}</Box>
    </Box>
  );
}
