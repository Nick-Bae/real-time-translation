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
      } catch {}
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

    if (revokeUrlRef.current) {
      URL.revokeObjectURL(revokeUrlRef.current);
      revokeUrlRef.current = null;
    }

    if (item.url) {
      el.src = item.url;
    } else if (item.blob) {
      const u = URL.createObjectURL(item.blob);
      revokeUrlRef.current = u;
      el.src = u;
    } else if (item.arrayBuffer) {
      const blob = new Blob([item.arrayBuffer], { type: "audio/mpeg" });
      const u = URL.createObjectURL(blob);
      revokeUrlRef.current = u;
      el.src = u;
    } else {
      // no audio data
      setQueue((prev) => prev.slice(1));
      return;
    }

    try {
      playingRef.current = true;
      await el.play();
    } catch (err) {
      // autoplay blocked or other error: skip this item
      playingRef.current = false;
      setQueue((prev) => prev.slice(1));
      // optional: surface the error to UI if you want
      // console.warn("Audio play failed:", err);
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
      } catch {}
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
