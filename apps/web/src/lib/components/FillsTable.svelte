<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { FillDto } from "../api/types.js";
  import { financialTone, formatInteger, formatMoney, formatPrice, formatTime } from "../format.js";

  interface Props {
    fills: readonly FillDto[];
    loading: boolean;
    error: string | null;
    onLoadMore?: () => void;
    hasMore?: boolean;
  }
  let { fills, loading, error, onLoadMore, hasMore = false }: Props = $props();

  function reason(fill: FillDto): string | null {
    if (fill.isLiquidation) return "liquidation";
    if (fill.isTpSl) return "TP/SL";
    if (fill.orderId === null) return "forced close";
    return null;
  }
</script>

{#if loading && fills.length === 0}
  <StateMessage kind="loading" message="Memuat fill…" />
{:else if error !== null}
  <StateMessage kind="error" message="Gagal memuat fill" detail={error} />
{:else if fills.length === 0}
  <StateMessage kind="empty" message="No fills yet" />
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Time</th><th scope="col">Contract</th><th scope="col">Side</th><th scope="col" class="num">Price</th>
          <th scope="col" class="num">Size</th><th scope="col" class="num">Fee</th><th scope="col" class="num">Realized PnL</th><th scope="col">Liquidity</th>
        </tr>
      </thead>
      <tbody>
        {#each fills as fill (fill.id)}
          <tr>
            <td class="tabular">{formatTime(fill.timestamp, true)}</td>
            <td>{fill.contract}</td>
            <td class={fill.side === "buy" ? "positive" : "negative"}>{fill.side === "buy" ? "▲ BUY" : "▼ SELL"}</td>
            <td class="num tabular">{formatPrice(fill.price)}</td>
            <td class="num tabular">{formatInteger(fill.size)}</td>
            <td class="num tabular" class:negative={financialTone(fill.fee) === "negative"} class:positive={financialTone(fill.fee) === "positive"}>{formatMoney(fill.fee, 8)}</td>
            <td class="num tabular {financialTone(fill.realizedPnl) === "positive" ? "positive" : financialTone(fill.realizedPnl) === "negative" ? "negative" : ""}">{formatMoney(fill.realizedPnl, 8)}</td>
            <td>
              <span class="liq">{fill.liquidity}</span>
              {#if reason(fill) !== null}<span class="reason">{reason(fill)}</span>{/if}
            </td>
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
  .liq { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 4px; font-size: 10px; color: var(--text-secondary); }
  .reason { margin-left: 5px; font-size: 10px; color: var(--warning); }
  .more { margin: 6px auto; background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 3px 10px; font-size: 11px; cursor: pointer; }
</style>
