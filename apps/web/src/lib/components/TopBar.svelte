<script lang="ts">
  import PaperBadge from "./PaperBadge.svelte";
  import FeedStatusBadge from "./FeedStatusBadge.svelte";
  import type { FeedStatus } from "../stores/terminal.svelte.js";

  interface Props {
    contract: string;
    backendMode: "simulation" | "live" | null;
    feedStatus: FeedStatus;
    feedDetail?: string;
    email?: string;
    onToggleTheme: () => void;
    onToggleWatchlist: () => void;
  }
  let { contract, backendMode, feedStatus, feedDetail, onToggleTheme, onToggleWatchlist }: Props = $props();

  const modeLabel = $derived(backendMode === "live" ? "LIVE MARKET" : backendMode === "simulation" ? "SIMULATION" : "…");
</script>

<header class="topbar surface-raised">
  <button class="icon" type="button" onclick={onToggleWatchlist} aria-label="Tampilkan/sembunyikan watchlist">☰</button>
  <span class="brand">crypastra</span>
  <PaperBadge />
  <span class="symbol tabular">{contract}</span>
  <span class="mode" title="Sumber data pasar. Eksekusi tetap paper.">{modeLabel} · PAPER</span>

  <span class="spacer"></span>
  <FeedStatusBadge status={feedStatus} detail={feedDetail} />
  <button class="icon" type="button" onclick={onToggleTheme} aria-label="Ganti tema terang/gelap">◐</button>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    height: 44px;
    border-left: none;
    border-right: none;
    border-top: none;
  }
  .brand { font-weight: 700; letter-spacing: 0.02em; }
  .symbol { font-size: 13px; font-weight: 600; }
  .mode {
    font-size: 10px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    letter-spacing: 0.04em;
  }
  .spacer { flex: 1; }
  .icon {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    width: 26px;
    height: 24px;
    cursor: pointer;
  }
  .icon:hover { color: var(--text-primary); border-color: var(--border-strong); }
</style>
