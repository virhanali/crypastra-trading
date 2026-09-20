<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { LedgerEntryDto } from "../api/types.js";
  import { financialTone, formatMoney, formatTime, isZeroDecimal } from "../format.js";

  interface Props {
    entries: readonly LedgerEntryDto[];
    loading: boolean;
    error: string | null;
    onLoadMore?: () => void;
    hasMore?: boolean;
  }
  let { entries, loading, error, onLoadMore, hasMore = false }: Props = $props();

  /**
   * Efek finansial dibuat eksplisit: tanda + label arah, bukan hanya warna.
   * `amount` bertanda (positif menambah kas), `margin_delta`/`reserved_delta`
   * menggerakkan margin tanpa menyentuh kas.
   */
  function effect(value: string): { label: string; tone: string } {
    const tone = financialTone(value);
    if (tone === "positive") return { label: "▲ kas bertambah", tone: "positive" };
    if (tone === "negative") return { label: "▼ kas berkurang", tone: "negative" };
    return { label: "• tanpa perubahan kas", tone: "" };
  }

  function delta(value: string): string {
    return isZeroDecimal(value) ? "—" : formatMoney(value, 8);
  }
</script>

{#if loading && entries.length === 0}
  <StateMessage kind="loading" message="Memuat ledger…" />
{:else if error !== null}
  <StateMessage kind="error" message="Gagal memuat ledger" detail={error} />
{:else if entries.length === 0}
  <StateMessage kind="empty" message="Ledger kosong" detail="Setiap efek ekonomi akan tercatat di sini secara append-only." />
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Time</th><th scope="col">Type</th><th scope="col" class="num">Amount</th>
          <th scope="col" class="num">Balance After</th><th scope="col" class="num">Margin Δ</th>
          <th scope="col" class="num">Reserved Δ</th><th scope="col">Reference</th><th scope="col">Effect</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.seq)}
          <tr>
            <td class="tabular">{formatTime(entry.timestamp, true)}</td>
            <td class="type">{entry.type}</td>
            <td class="num tabular {financialTone(entry.amount) === "positive" ? "positive" : financialTone(entry.amount) === "negative" ? "negative" : ""}">{formatMoney(entry.amount, 8)}</td>
            <td class="num tabular">{formatMoney(entry.balanceAfter, 8)}</td>
            <td class="num tabular">{delta(entry.marginDelta)}</td>
            <td class="num tabular">{delta(entry.reservedDelta)}</td>
            <td class="muted">{entry.reference.type ?? "—"}</td>
            <td class={effect(entry.amount).tone}>{effect(entry.amount).label}</td>
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
  .type { font-weight: 600; }
  .more { margin: 6px auto; background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 3px 10px; font-size: 11px; cursor: pointer; }
</style>
