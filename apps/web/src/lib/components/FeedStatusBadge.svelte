<script lang="ts">
  import type { FeedStatus } from "../stores/terminal.svelte.js";

  interface Props {
    status: FeedStatus;
    detail?: string;
  }
  let { status, detail }: Props = $props();

  const tone = $derived(
    status === "LIVE"
      ? "var(--positive)"
      : status === "STALE" || status === "DEGRADED"
        ? "var(--warning)"
        : status === "RECONNECTING"
          ? "var(--info)"
          : status === "SIMULATION"
            ? "var(--accent)"
            : "var(--negative)",
  );
</script>

<span class="feed" style:color={tone} style:border-color={tone} title={detail ?? status}>
  <span class="dot" style:background={tone} aria-hidden="true"></span>
  {status}
</span>

<style>
  .feed {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid;
    border-radius: var(--radius-sm);
    padding: 1px 7px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .dot { width: 6px; height: 6px; border-radius: 999px; }
</style>
