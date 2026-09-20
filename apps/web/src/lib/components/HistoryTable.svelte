<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { HistoryEntryDto } from "../api/types.js";
  import { financialTone, formatInteger, formatMoney, formatPrice, formatTime } from "../format.js";

  interface Props {
    entries: readonly HistoryEntryDto[];
    loading: boolean;
    error: string | null;
    onLoadMore?: () => void;
    hasMore?: boolean;
  }
  let { entries, loading, error, onLoadMore, hasMore = false }: Props = $props();

  const pnlClass = (value: string) => {
    const tone = financialTone(value);
    return tone === "positive" ? "positive" : tone === "negative" ? "negative" : "";
  };
</script>

{#if loading && entries.length === 0}
  <StateMessage kind="loading" message="Memuat riwayat…" />
{:else if error !== null}
  <StateMessage kind="error" message="Gagal memuat riwayat" detail={error} />
{:else if entries.length === 0}
  <StateMessage kind="empty" message="Belum ada riwayat posisi" />
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Opened</th><th scope="col">Closed</th><th scope="col">Contract</th><th scope="col">Side</th>
          <th scope="col">Status</th><th scope="col" class="num">Size</th><th scope="col" class="num">Entry</th>
          <th scope="col" class="num">Realized PnL</th><th scope="col" class="num">Funding</th><th scope="col" class="num">Fees</th><th scope="col">Reason</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.id)}
          <tr>
            <td class="tabular">{formatTime(entry.openedAt, true)}</td>
            <td class="tabular">{formatTime(entry.closedAt, true)}</td>
            <td>{entry.contract}</td>
            <td class={entry.side === "long" ? "positive" : "negative"}>{entry.side === "long" ? "▲ LONG" : "▼ SHORT"}</td>
            <td class="muted">{entry.status}</td>
            <td class="num tabular">{formatInteger(entry.size)}</td>
            <td class="num tabular">{formatPrice(entry.entryPrice)}</td>
            <td class="num tabular {pnlClass(entry.realizedPnl)}">{formatMoney(entry.realizedPnl, 8)}</td>
            <td class="num tabular">{formatMoney(entry.accumulatedFunding, 8)}</td>
            <td class="num tabular">{formatMoney(entry.feesPaid, 8)}</td>
            <td class="muted">{entry.closeReason ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if hasMore && onLoadMore}
    <button class="more" type="button" onclick={onLoadMore} disabled={loading}>{loading ? "Memuat…" : "Muat lebih banyak"}</button>
  {/if}
{/if}

<style>
  .scroll { overflow: auto; max-height: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; background: var(--surface-raised); color: var(--text-muted); font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--surface-sunken); white-space: nowrap; }
  .num { text-align: right; }
  .positive { color: var(--positive); }
  .negative { color: var(--negative); }
  .muted { color: var(--text-muted); font-size: 11px; }
  .more { margin: 6px auto; background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 3px 10px; font-size: 11px; cursor: pointer; }
</style>
