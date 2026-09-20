<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { ContractDto } from "../api/types.js";
  import type { MarketStateView } from "../stores/terminal.svelte.js";
  import { formatPrice } from "../format.js";

  interface Props {
    contracts: readonly ContractDto[];
    selected: string;
    states: Record<string, MarketStateView | undefined>;
    loading: boolean;
    error: string | null;
    collapsed: boolean;
    onSelect: (contract: string) => void;
  }
  let { contracts, selected, states, loading, error, collapsed, onSelect }: Props = $props();

  let query = $state("");

  const visible = $derived(
    contracts.filter((entry) => entry.contract.toUpperCase().includes(query.trim().toUpperCase())),
  );

  function tone(mark: string | null | undefined): string {
    return mark == null ? "var(--text-muted)" : "var(--text-primary)";
  }
</script>

<aside class="watchlist surface" data-collapsed={collapsed}>
  {#if !collapsed}
    <div class="head">
      <input
        type="search"
        placeholder="Cari kontrak…"
        bind:value={query}
        aria-label="Cari kontrak"
      />
    </div>
  {/if}

  {#if loading && contracts.length === 0}
    <StateMessage kind="loading" message="Memuat kontrak…" />
  {:else if error !== null}
    <StateMessage kind="error" message="Gagal memuat kontrak" detail={error} />
  {:else if visible.length === 0}
    <StateMessage kind="empty" message="Tidak ada kontrak cocok" />
  {:else}
    <ul>
      {#each visible as entry (entry.contract)}
        <li>
          <button
            type="button"
            class="row"
            aria-current={entry.contract === selected ? "true" : undefined}
            onclick={() => onSelect(entry.contract)}
          >
            <span class="sym">{entry.contract.replace("_USDT", "")}<span class="quote">/USDT</span></span>
            <span class="mark tabular" style:color={tone(states[entry.contract]?.markPrice)}>
              {formatPrice(states[entry.contract]?.markPrice ?? null)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .watchlist { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .watchlist[data-collapsed="true"] { display: none; }
  .head { padding: 6px; border-bottom: 1px solid var(--border); }
  input {
    width: 100%;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    padding: 4px 6px;
    font-size: 12px;
  }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
  .row {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--surface-sunken);
    color: var(--text-secondary);
    padding: 6px 8px;
    cursor: pointer;
    font-size: 12px;
    text-align: left;
  }
  .row:hover { background: var(--surface-raised); color: var(--text-primary); }
  .row[aria-current="true"] { background: var(--accent-soft); color: var(--text-primary); box-shadow: inset 2px 0 0 var(--accent); }
  .sym { font-weight: 600; }
  .quote { color: var(--text-muted); font-weight: 400; }
</style>
