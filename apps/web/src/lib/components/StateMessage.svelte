<script lang="ts">
  /**
   * Keadaan panel: loading / empty / error / stale / disconnected.
   * Tujuannya agar TIDAK ADA panel yang tinggal persegi kosong.
   */
  type Kind = "loading" | "empty" | "error" | "stale" | "disconnected";
  interface Props {
    kind: Kind;
    message: string;
    detail?: string;
    actionLabel?: string;
    onAction?: () => void;
  }
  let { kind, message, detail, actionLabel, onAction }: Props = $props();

  const tone = $derived(
    kind === "error" ? "var(--negative)" : kind === "stale" ? "var(--warning)" : "var(--text-muted)",
  );
  const glyph = $derived(
    kind === "loading" ? "…" : kind === "empty" ? "∅" : kind === "error" ? "!" : kind === "stale" ? "⏱" : "⚠",
  );
</script>

<div class="state" role={kind === "error" ? "alert" : "status"}>
  <span class="glyph" style:color={tone} aria-hidden="true">{glyph}</span>
  <div class="text">
    <span style:color={tone}>{message}</span>
    {#if detail}<span class="detail">{detail}</span>{/if}
  </div>
  {#if actionLabel && onAction}
    <button type="button" onclick={onAction}>{actionLabel}</button>
  {/if}
</div>

<style>
  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 12px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .glyph { font-size: 14px; line-height: 1; }
  .text { display: flex; flex-direction: column; gap: 2px; }
  .detail { color: var(--text-muted); font-size: 11px; }
  button {
    margin-left: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
  }
</style>
