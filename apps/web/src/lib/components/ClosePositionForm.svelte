<script lang="ts">
  import type { PositionDto } from "../api/types.js";
  import { formatInteger, formatMoney, formatPrice } from "../format.js";

  interface Props {
    position: PositionDto;
    /** Kutipan eksekusi dari pasar server; null = tidak aman untuk menutup. */
    executableQuote: { bid: string | null; ask: string | null };
    pending: boolean;
    error: string | null;
    onConfirm: () => void;
    onCancel: () => void;
  }
  let { position, executableQuote, pending, error, onConfirm, onCancel }: Props = $props();

  // Penutupan memakai kutipan sisi yang benar: LONG ditutup di BID, SHORT di ASK.
  const closePrice = $derived(position.side === "long" ? executableQuote.bid : executableQuote.ask);
  const canClose = $derived(closePrice !== null && !pending);
</script>

<div class="close surface-raised" role="dialog" aria-label="Tutup posisi" tabindex="-1" onkeydown={(event) => event.key === "Escape" && onCancel()}>
  <header>
    <span class="title">Close · {position.contract}</span>
    <button type="button" class="x" onclick={onCancel} aria-label="Tutup">✕</button>
  </header>
  <dl>
    <div><dt>Arah</dt><dd>{position.side === "long" ? "▲ LONG" : "▼ SHORT"}</dd></div>
    <div><dt>Size</dt><dd class="tabular">{formatInteger(position.size)} kontrak</dd></div>
    <div><dt>Entry</dt><dd class="tabular">{formatPrice(position.entryPrice)}</dd></div>
    <div><dt>UPnL</dt><dd class="tabular">{formatMoney(position.unrealizedPnl, 8)}</dd></div>
    <div><dt>Harga eksekusi</dt><dd class="tabular">{formatPrice(closePrice)}</dd></div>
  </dl>
  <p class="muted">Penutupan penuh. PnL realisasi ditentukan backend.</p>
  {#if closePrice === null}
    <p class="warn" role="status">Waiting for executable market quote…</p>
  {/if}
  {#if error !== null}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button type="button" class="primary" disabled={!canClose} onclick={onConfirm}>
      {pending ? "Menutup…" : "Tutup Posisi (PAPER)"}
    </button>
    <button type="button" onclick={onCancel}>Batal</button>
  </div>
</div>

<style>
  .close { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--radius-md); }
  header { display: flex; align-items: center; }
  .title { font-size: 11px; font-weight: 600; }
  .x { margin-left: auto; background: transparent; border: none; color: var(--text-muted); cursor: pointer; }
  dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
  dl div { display: flex; justify-content: space-between; gap: 8px; }
  dt { color: var(--text-muted); font-size: 10px; }
  dd { margin: 0; font-size: 11px; }
  .muted { margin: 0; font-size: 10px; color: var(--text-muted); }
  .warn { margin: 0; font-size: 10px; color: var(--warning); }
  .error { margin: 0; font-size: 10px; color: var(--negative); }
  .actions { display: flex; gap: 6px; }
  .actions button { background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 4px 9px; font-size: 11px; cursor: pointer; }
  .actions .primary { background: var(--negative-soft); border-color: var(--negative); color: var(--negative); }
  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
