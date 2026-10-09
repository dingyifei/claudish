/**
 * useModelDescriptions — the catalog's prose sentence per model, on its own clock.
 *
 * IT IS DELIBERATELY THE LAST THING TO ARRIVE. The list is built from the slim
 * catalog, which carries no `description` at all (0 of 704 entries on disk), so
 * the sentence comes from a bulk fetch of the rich catalog — MEASURED at 2.8 s for
 * all 1 016 active models, cached on disk for a day. Nothing waits for it: the
 * rows are already usable, and a description is worth having on the row the cursor
 * is on and worth nothing on a row nobody has looked at.
 *
 * `DescriptionIndex.size === 0` therefore means "not loaded yet", never "no model
 * has one" — which is why the detail block renders blank rows rather than
 * collapsing. A block that grew by two rows when this landed would shove the
 * footer down under the reader's cursor, seconds after they started reading.
 */

import { useEffect, useRef, useState } from "react";
import {
  type DescriptionIndex,
  emptyDescriptionIndex,
} from "../../providers/model-descriptions.js";
import { useMounted } from "../../tui/hooks/useMounted.js";
import type { PickerDataSource } from "../PickerDataSource.js";

export function useModelDescriptions(
  source: PickerDataSource,
  /**
   * FALSE UNTIL A MODEL LIST IS ON SCREEN. A description describes a MODEL, and
   * the picker now opens on the provider list, where not one of them can be
   * shown — so fetching the index at startup would be a megabyte spent on a
   * screen that has nowhere to put it. Same rule as the catalog warm beside it:
   * on demand, once, when the view that uses it is asked for.
   */
  enabled = true
): DescriptionIndex {
  const [index, setIndex] = useState<DescriptionIndex>(emptyDescriptionIndex);
  /** Asked for ONCE per picker open, however often `enabled` flips. */
  const asked = useRef(false);
  const mounted = useMounted();

  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    void source.descriptions().then(
      (loaded) => {
        // Kept whenever it lands. It is asked for once, so dropping it because
        // the user left the model view mid-fetch left every description blank
        // for the rest of the run. Only an unmount discards it.
        if (mounted.current) setIndex(loaded);
      },
      () => {
        // Documented never to reject; guarded anyway. A missing sentence must
        // never be able to take the picker down.
      }
    );
  }, [source, enabled, mounted]);

  return index;
}
