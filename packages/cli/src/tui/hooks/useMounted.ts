/**
 * useMounted — a ref that reads `true` while the component is mounted, `false` after.
 *
 * For an async result that must survive the component's own state changes but not
 * its unmount. The tempting alternative — a `let live = true` flipped by the
 * effect's cleanup — is tied to the effect's DEPENDENCIES, so it fires on every
 * dependency change, not only on unmount. That quietly turns "is anyone still here
 * to receive this?" into "is the same view still showing?", and a result that is
 * asked for only once is then dropped for good. The picker's catalog warm and its
 * description index both did exactly that: step back mid-fetch, and the dialog
 * said `fetching…` for the rest of the run with the data already on disk.
 */

import { type RefObject, useEffect, useRef } from "react";

export function useMounted(): RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    // Re-asserted on mount, so a renderer that mounts, unmounts and remounts the
    // same instance does not leave the ref reading `false` while it is on screen.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
