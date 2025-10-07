// frontend/lib/useAudioQueue.ts
import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react";

export type QueueItem = {
  url?: string;
  blob?: Blob;
  arrayBuffer?: ArrayBuffer;
  seq?: number; // optional ordering
};

export function useAudioQueue(audioRef: MutableRefObject<HTMLAudioElement | null>) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const playingRef = useRef(false);
  const revokeUrlRef = useRef<string | null>(null);

  const handleEnded = useCallback(() => {
    playingRef.current = false;
    setQueue((prev) => prev.slice(1));
  }, []);

  const handleError = useCallback((_e: any) => {
    playingRef.current = false;
    setQueue((prev) => prev.slice(1));
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    el.preload = "auto";
    el.autoplay = false;

    el.addEventListener("ended", handleEnded);
    el.addEventListener("error", handleError);

    return () => {
      el.removeEventListener("ended", handleEnded);
      el.removeEventListener("error", handleError);
      // stop & cleanup
      try {
        el.pause();
        el.currentTime = 0;
        el.removeAttribute("src");
        el.load();
      } catch { }
      if (revokeUrlRef.current) {
        URL.revokeObjectURL(revokeUrlRef.current);
        revokeUrlRef.current = null;
      }
      playingRef.current = false;
    };
  }, [audioRef, handleEnded, handleError]);

  useEffect(() => {
    if (playingRef.current) return;
    if (!audioRef.current) return;
    if (queue.length === 0) return;

    void start(queue[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const start = useCallback(async (item: QueueItem) => {
  const el = audioRef.current;
  if (!el) return;

  // Revoke previous object URL if any
  if (revokeUrlRef.current) {
    URL.revokeObjectURL(revokeUrlRef.current);
    revokeUrlRef.current = null;
  }

  // Hard reset BEFORE swapping source
  try {
    el.pause();
    el.currentTime = 0;
    el.removeAttribute("src");
    el.load();
  } catch {}

  // Build a URL for the item
  let url: string | null = null;
  if (item.url) {
    url = item.url;
  } else if (item.blob) {
    if (!item.blob.size) { setQueue((p) => p.slice(1)); return; }
    url = URL.createObjectURL(item.blob);
    revokeUrlRef.current = url;
  } else if (item.arrayBuffer) {
    if (!item.arrayBuffer.byteLength) { setQueue((p) => p.slice(1)); return; }
    const blob = new Blob([item.arrayBuffer], { type: "audio/mpeg" });
    url = URL.createObjectURL(blob);
    revokeUrlRef.current = url;
  } else {
    setQueue((p) => p.slice(1));
    return;
  }

  // Assign src, then explicitly load, then wait metadata
  el.src = url;
  el.load();

  const ok = await new Promise<boolean>((resolve) => {
    const onLoaded = () => { cleanup(); resolve(true); };
    const onErr = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onErr);
    };
    el.addEventListener("loadedmetadata", onLoaded, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });

  if (!ok) {
    // Drop this item and continue
    setQueue((p) => p.slice(1));
    return;
  }

  try {
    playingRef.current = true;
    el.currentTime = 0; // always start at 0 to avoid stale seeks
    await el.play();
  } catch {
    playingRef.current = false;
    setQueue((p) => p.slice(1));
  }
}, [audioRef]);

  const enqueue = useCallback((item: QueueItem) => {
    setQueue((prev) => {
      if (item.seq != null) {
        const next = [...prev, item].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        return next;
      }
      return [...prev, item];
    });
  }, []);

  const clear = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      try {
        el.pause();
        el.currentTime = 0;
        el.removeAttribute("src");
        el.load();
      } catch { }
    }
    if (revokeUrlRef.current) {
      URL.revokeObjectURL(revokeUrlRef.current);
      revokeUrlRef.current = null;
    }
    playingRef.current = false;
    setQueue([]);
  }, [audioRef]);

  const isPlaying = playingRef.current;

  return { enqueue, clear, isPlaying, size: queue.length };
}
