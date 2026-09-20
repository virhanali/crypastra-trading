<script lang="ts">
  import PositionsTable from "./PositionsTable.svelte";
  import OrdersTable from "./OrdersTable.svelte";
  import FillsTable from "./FillsTable.svelte";
  import HistoryTable from "./HistoryTable.svelte";
  import LedgerTable from "./LedgerTable.svelte";
  import type { FillDto, HistoryEntryDto, LedgerEntryDto, OrderDto, PositionDto } from "../api/types.js";

  export type WorkspaceTab = "positions" | "orders" | "fills" | "history" | "ledger";

  interface Props {
    active: WorkspaceTab;
    positions: readonly PositionDto[];
    orders: readonly OrderDto[];
    fills: readonly FillDto[];
    history: readonly HistoryEntryDto[];
    ledger: readonly LedgerEntryDto[];
    loading: boolean;
    error: string | null;
    stale: boolean;
    fillsHasMore: boolean;
    historyHasMore: boolean;
    ledgerHasMore: boolean;
    onSelectTab: (tab: WorkspaceTab) => void;
    onCancelOrder?: (order: OrderDto) => void;
    onClosePosition?: (position: PositionDto) => void;
    onEditProtection?: (position: PositionDto) => void;
    pendingOrderId?: string | null;
    pendingPositionId?: string | null;
    actionError?: string | null;
    onLoadMoreFills: () => void;
    onLoadMoreHistory: () => void;
    onLoadMoreLedger: () => void;
  }
  let {
    active, positions, orders, fills, history, ledger, loading, error, stale,
    fillsHasMore, historyHasMore, ledgerHasMore,
    onSelectTab, onLoadMoreFills, onLoadMoreHistory, onLoadMoreLedger,
    onCancelOrder, onClosePosition, onEditProtection,
    pendingOrderId = null, pendingPositionId = null, actionError = null,
  }: Props = $props();

  const tabs = $derived([
    { id: "positions" as const, label: "Positions", count: positions.length },
    { id: "orders" as const, label: "Orders", count: orders.length },
    { id: "fills" as const, label: "Fills", count: fills.length },
    { id: "history" as const, label: "History", count: history.length },
    { id: "ledger" as const, label: "Ledger", count: ledger.length },
  ]);
</script>

<section class="workspace surface">
  <div class="tabs" role="tablist" aria-label="Workspace">
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        aria-selected={active === tab.id}
        class:active={active === tab.id}
        onclick={() => onSelectTab(tab.id)}
      >
        {tab.label}
        <span class="count tabular">{tab.count}</span>
      </button>
    {/each}
  </div>

  <div class="panel" role="tabpanel">
    {#if active === "positions"}
      <PositionsTable {positions} {loading} {error} {stale} {pendingPositionId} {actionError} onClose={onClosePosition} onEditProtection={onEditProtection} />
    {:else if active === "orders"}
      <OrdersTable {orders} {loading} {error} {pendingOrderId} {actionError} onCancel={onCancelOrder} />
    {:else if active === "fills"}
      <FillsTable {fills} {loading} {error} hasMore={fillsHasMore} onLoadMore={onLoadMoreFills} />
    {:else if active === "history"}
      <HistoryTable entries={history} {loading} {error} hasMore={historyHasMore} onLoadMore={onLoadMoreHistory} />
    {:else}
      <LedgerTable entries={ledger} {loading} {error} hasMore={ledgerHasMore} onLoadMore={onLoadMoreLedger} />
    {/if}
  </div>
</section>

<style>
  .workspace { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); padding: 0 4px; background: var(--surface-raised); }
  .tabs button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    padding: 6px 10px;
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .tabs button:hover { color: var(--text-primary); }
  .tabs button.active { color: var(--text-primary); border-bottom-color: var(--accent); }
  .count { color: var(--text-muted); font-size: 10px; }
  .panel { flex: 1; min-height: 0; overflow: hidden; }
</style>
