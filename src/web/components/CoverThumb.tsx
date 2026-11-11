import { AspectRatio, Center, Image } from "@mantine/core";
import { IconBook2 } from "@tabler/icons-react";

interface Props {
  bookId: number;
  hasCover: boolean;
  /** Pixel width, or a CSS width such as "100%" (height follows a 2:3 ratio). */
  width: number | string;
  size?: "thumb" | "full";
  /** Changes when the cover is replaced, to bypass the browser cache. */
  version?: string;
}

/** Book cover with a neutral placeholder, always 2:3. */
export function CoverThumb({ bookId, hasCover, width, size = "thumb", version }: Props) {
  const iconSize = typeof width === "number" ? width * 0.5 : 40;
  return (
    <AspectRatio ratio={2 / 3} w={width} style={{ flexShrink: 0 }}>
      {hasCover ? (
        <Image
          src={`/api/books/${bookId}/cover?size=${size}${version ? `&v=${encodeURIComponent(version)}` : ""}`}
          fit="cover"
          radius={4}
          loading="lazy"
          alt=""
        />
      ) : (
        <Center bg="var(--mantine-color-default-hover)" style={{ borderRadius: 4 }}>
          <IconBook2 size={iconSize} color="var(--mantine-color-dimmed)" />
        </Center>
      )}
    </AspectRatio>
  );
}
