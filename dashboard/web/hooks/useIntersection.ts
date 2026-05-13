// Standard IntersectionObserver hook. Returns a stable RefCallback that
// attaches an observer to the target element, plus the latest
// `isIntersecting` value. The observer is recreated only when the callback
// or options materially change.

import { useCallback, useEffect, useRef, useState } from "react";

export type UseIntersectionOptions = {
  rootMargin?: string;
  threshold?: number;
};

export function useIntersection<T extends Element>(
  options: UseIntersectionOptions = {},
): { ref: (node: T | null) => void; isIntersecting: boolean } {
  const { rootMargin = "200px", threshold = 0 } = options;
  const [isIntersecting, setIntersecting] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<T | null>(null);

  const attach = useCallback((node: T | null) => {
    if (observerRef.current) {
      try {
        observerRef.current.disconnect();
      } catch {
        /* ignore */
      }
      observerRef.current = null;
    }
    nodeRef.current = node;
    if (!node) {
      setIntersecting(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      // SSR / very old browsers — assume always visible.
      setIntersecting(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          setIntersecting(e.isIntersecting);
        }
      },
      { rootMargin, threshold },
    );
    obs.observe(node);
    observerRef.current = obs;
  }, [rootMargin, threshold]);

  useEffect(() => {
    return () => {
      if (observerRef.current) {
        try {
          observerRef.current.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  return { ref: attach, isIntersecting };
}
