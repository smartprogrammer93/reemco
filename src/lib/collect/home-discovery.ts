/**
 * REEA-1070 AC1 — the server-only home discovery runner.
 *
 * The homepage starts ONE live staged fan-out per discovery query (the same
 * runs its chip pre-warm already paid for) and this module awaits the
 * finalized snapshot of each run, then projects the pure home-module contract
 * in lib/home-discovery.ts. No bundled catalogue is read here: a module item
 * exists only because an adapter answered this load.
 *
 * Graceful degradation is explicit: a run that rejects becomes a null
 * snapshot and the builder reports the no-response state instead of blanking
 * the whole home page.
 */
import { getStrings } from "@/lib/i18n";
import type { LiveSearchStages } from "@/lib/collect/live-search";
import {
  buildHomeDiscovery,
  type HomeDiscovery,
  type HomeDiscoverySnapshot,
} from "@/lib/home-discovery";

export interface HomeDiscoveryRun {
  query: string;
  stages: LiveSearchStages;
}

export async function collectHomeDiscovery(
  runs: readonly HomeDiscoveryRun[],
): Promise<HomeDiscovery> {
  const snapshots: HomeDiscoverySnapshot[] = await Promise.all(
    runs.map(async ({ query, stages }) => {
      try {
        return { query, snap: await stages.final };
      } catch {
        // One retailer/query failure must not blank the home modules; the
        // builder names the no-response state for this query instead.
        return { query, snap: null };
      }
    }),
  );
  return buildHomeDiscovery(snapshots, {
    en: getStrings("en").footerDisclosure,
    ar: getStrings("ar").footerDisclosure,
  });
}
