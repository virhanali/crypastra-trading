<script lang="ts">
  /** Identitas PAPER: harus selalu terlihat agar tidak tertukar dengan uang nyata. */
  interface Props {
    size?: "sm" | "md";
  }
  let { size = "md" }: Props = $props();
</script>

<span class="badge" data-size={size} title="Uang virtual. Tidak ada order yang dikirim ke exchange.">PAPER</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--warning-soft);
    color: var(--warning);
    border: 1px solid var(--warning);
    border-radius: var(--radius-sm);
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 2px 7px;
  }
  .badge[data-size="md"] { font-size: 11px; }
  .badge[data-size="sm"] { font-size: 10px; padding: 1px 5px; }
</style>
