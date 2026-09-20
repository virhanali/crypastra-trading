<script lang="ts">
  import type { PositionDto } from "../api/types.js";
  import { formatPrice } from "../format.js";

  interface Props {
    position: PositionDto;
    pending: boolean;
    error: string | null;
    onApply: (input: { takeProfitPrice: string | null | undefined; stopLossPrice: string | null | undefined }) => void;
    onCancel: () => void;
  }
  let { position, pending, error, onApply, onCancel }: Props = $props();

  // Nilai AWAL saja (disengaja): setelah dibuka, input dikendalikan pengguna.
  // String mentah; kosong = "kosongkan", tidak disentuh = "pertahankan".
  // svelte-ignore state_referenced_locally
  let tp = $state(position.takeProfitPrice ?? "");
  // svelte-ignore state_referenced_locally
  let sl = $state(position.stopLossPrice ?? "");
  let touchTp = $state(false);
  let touchSl = $state(false);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      onCancel();
    }
  }
</script>

<div class="protection surface-raised" role="dialog" aria-label="Ubah TP/SL" tabindex="-1" onkeydown={onKeydown}>
  <header>
    <span class="title">Protection · {position.contract}</span>
    <button type="button" class="close" onclick={onCancel} aria-label="Tutup">✕</button>
  </header>
  <p class="muted">
    {position.side === "long" ? "▲ LONG" : "▼ SHORT"}
    · entry <b class="tabular">{formatPrice(position.entryPrice)}</b>
    · <b>MARK-triggered</b>
  </p>
  <label>
    Take Profit
    <input class="tabular" inputmode="decimal" bind:value={tp} oninput={() => (touchTp = true)} placeholder="kosongkan untuk hapus" />
  </label>
  <label>
    Stop Loss
    <input class="tabular" inputmode="decimal" bind:value={sl} oninput={() => (touchSl = true)} placeholder="kosongkan untuk hapus" />
  </label>
  {#if error !== null}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button type="button" class="primary" disabled={pending} onclick={() =>
      onApply({
        takeProfitPrice: touchTp ? (tp === "" ? null : tp) : undefined,
        stopLossPrice: touchSl ? (sl === "" ? null : sl) : undefined,
      })}>
      {pending ? "Menyimpan…" : "Simpan"}
    </button>
    <button type="button" onclick={onCancel}>Batal</button>
  </div>
</div>

<style>
  .protection { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--radius-md); }
  header { display: flex; align-items: center; }
  .title { font-size: 11px; font-weight: 600; }
  .close { margin-left: auto; background: transparent; border: none; color: var(--text-muted); cursor: pointer; }
  .muted { margin: 0; font-size: 10px; color: var(--text-muted); }
  label { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  input { background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 4px 6px; font-size: 12px; }
  .error { margin: 0; color: var(--negative); font-size: 10px; }
  .actions { display: flex; gap: 6px; }
  .actions button { background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 4px 9px; font-size: 11px; cursor: pointer; }
  .actions button.primary { background: var(--accent-soft); border-color: var(--accent); }
  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
