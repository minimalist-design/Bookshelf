import { Menu } from "@mantine/core";
import { IconFolder, IconFolderSymlink, IconInbox } from "@tabler/icons-react";
import { useShelves } from "../../api/hooks.ts";

/** "Move to…" submenu listing Unshelved and every shelf. Must be placed inside a <Menu>. */
export function MoveToSubmenu({ onPick, current }: { onPick: (shelf: string | null) => void; current?: (string | null)[] }) {
  const shelves = useShelves();
  const only = current && current.length === 1 ? current[0] : undefined;
  return (
    <Menu.Sub>
      <Menu.Sub.Target>
        <Menu.Sub.Item leftSection={<IconFolderSymlink size={16} />}>Move to</Menu.Sub.Item>
      </Menu.Sub.Target>
      <Menu.Sub.Dropdown mah={360} style={{ overflowY: "auto" }}>
        {(shelves.data ?? []).map((s) => (
          <Menu.Item
            key={s.name ?? ""}
            leftSection={s.name === null ? <IconInbox size={16} /> : <IconFolder size={16} />}
            disabled={only !== undefined && only === s.name}
            onClick={() => onPick(s.name)}
          >
            {s.name ?? "Unshelved"}
          </Menu.Item>
        ))}
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  );
}
