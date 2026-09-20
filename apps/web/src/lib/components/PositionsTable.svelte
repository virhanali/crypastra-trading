<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { PositionDto } from "../api/types.js";
  import { financialTone, formatInteger, formatMoney, formatPrice } from "../format.js";

  interface Props {
    positions: readonly PositionDto[];
    loading: boolean;
    error: string | null;
    stale: boolean;
    pendingPositionId?: string | null;
    actionError?: string | null;
    onClose?: (position: PositionDto) => void;
    onEditProtection?: (position: PositionDto) => void;
  }
  let {
    positions, loading, error, stale,
    pendingPositionId = null, actionError = null, onClose, onEditProtection,
  }: Props = $props();

  const tone = (value: string | null) => {
    const result = financialTone(value);
    return result === "positive" ? "positive" : result === "negative" ? "negative" : "";
  };
  const sideLabel = (side: "long" | "short") => (side === "long" ? "LONG" : "SHORT");
</script>

{#if loading && positions.length === 0}
  <StateMessage kind="loading" message="Memuat posisi…" />
{:else if error !== null}
  <StateMessage kind="error" message="Gagal memuat posisi" detail={error} />
{:else if positions.length === 0}
  <StateMessage kind="empty" message="No open positions" detail="Posisi paper akan muncul di sini setelah order diisi." />
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Contract</th><th scope="col">Side</th><th scope="col" class="num">Size</th>
          <th scope="col" class="num">Entry</th><th scope="col" class="num">Mark</th><th scope="col" class="num">Liq. Price</th>
          <th scope="col" class="num">Margin</th><th scope="col" class="num">Lev</th><th scope="col" class="num">UPnL</th>
          <th scope="col" class="num">TP</th><th scope="col" class="num">SL</th><th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each positions as position (position.id)}
          <tr>
            <td>{position.contract}</td>
            <!-- LONG/SHORT dibedakan lewat TEKS + ikon, bukan hanya warna. -->
            <td class={position.side === "long" ? "positive" : "negative"}>
              {position.side === "long" ? "▲" : "▼"} {sideLabel(position.side)}
            </td>
            <td class="num tabular">{formatInteger(position.size)}</td>
            <td class="num tabular">{formatPrice(position.entryPrice)}</td>
            <td class="num tabular" class:stale-cell={position.valuationStatus !== "fresh"}>{formatPrice(position.markPrice)}</td>
            <td class="num tabular">{formatPrice(position.liquidationPrice)}</td>
            <td class="num tabular">{formatMoney(position.initialMargin, 4)}</td>
            <td class="num tabular">{formatInteger(position.leverage)}×</td>
            <td class="num tabular {tone(position.unrealizedPnl)}">{position.unrealizedPnl === null ? "—" : formatMoney(position.unrealizedPnl, 8)}</td>
            <td class="num tabular">{formatPrice(position.takeProfitPrice)}</td>
            <td class="num tabular">{formatPrice(position.stopLossPrice)}</td>
            <td class="actions">
              {#if onClose}
                <button type="button" class="action" disabled={pendingPositionId === position.id} onclick={() => onClose(position)}>Close</button>
              {/if}
              {#if onEditProtection}
                <button type="button" class="action" disabled={pendingPositionId === position.id} onclick={() => onEditProtection(position)}>TP/SL</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if actionError !== null}<p class="action-error" role="alert">{actionError}</p>{/if}
  {#if stale}<StateMessage kind="stale" message="Sebagian harga mark basi — UPnL mungkin belum terkini." />{/if}
{/if}

<style>
  .scroll { overflow: auto; max-height: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; background: var(--surface-raised); color: var(--text-muted); font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--surface-sunken); white-space: nowrap; }
  .num { text-align: right; }
  .positive { color: var(--positive); }
  .negative { color: var(--negative); }
  .muted { color: var(--text-muted); font-size: 10px; }
  .stale-cell { color: var(--warning); }
  .actions { display: flex; gap: 4px; }
  .action {
    background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-primary);
    border-radius: var(--radius-sm); padding: 2px 7px; font-size: 10px; cursor: pointer;
  }
  .action:hover:not(:disabled) { border-color: var(--border-strong); }
  .action:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-error { margin: 4px 8px; font-size: 10px; color: var(--negative); }
</style>
