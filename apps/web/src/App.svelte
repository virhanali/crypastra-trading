<script lang="ts">
  import TopBar from "./lib/components/TopBar.svelte";
  import Watchlist from "./lib/components/Watchlist.svelte";
  import MarketHeader from "./lib/components/MarketHeader.svelte";
  import PriceChart from "./lib/components/PriceChart.svelte";
  import AccountPanel from "./lib/components/AccountPanel.svelte";
  import OrderTicket from "./lib/components/OrderTicket.svelte";
  import ProtectionForm from "./lib/components/ProtectionForm.svelte";
  import ClosePositionForm from "./lib/components/ClosePositionForm.svelte";
  import BottomWorkspace, { type WorkspaceTab } from "./lib/components/BottomWorkspace.svelte";
  import { TerminalApi, ApiError } from "./lib/api/index.js";
  import type { AccountDto, AccountSummaryDto, CandleDto, ContractDto, FillDto, HistoryEntryDto, LedgerEntryDto, OrderDto, PositionDto } from "./lib/api/types.js";
  import { DomainStream, type DomainStreamState } from "./lib/realtime/domain-stream.js";
  import { MarketStream } from "./lib/realtime/market-stream.js";
  import { CommandBook, actionKey, defaultCommandId } from "./lib/command-id.js";
  import { pathForContract, routeFromPath } from "./lib/terminal-state.js";
  import {
    abandon,
    beginSubmit,
    canRetry,
    initialTicketState,
    submitDefinitivelyFailed,
    submitSucceeded,
    submitUncertain,
    type TicketState,
  } from "./lib/trade/ticket.js";
  import { defaultTimeInForce, type OrderIntent } from "./lib/trade/intent.js";
  import type { TicketSide, TicketType } from "./lib/trade/preview.js";
  import {
    applyMarketEvent,
    deriveFeedStatus,
    emptyMarketState,
    mergeServerState,
    type FeedStatus,
    type MarketStateView,
  } from "./lib/stores/terminal.svelte.js";

  const api = new TerminalApi();
  const commands = new CommandBook(defaultCommandId);
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  // ── state ──────────────────────────────────────────────────────
  let contracts = $state<ContractDto[]>([]);
  let contractsLoading = $state(true);
  let contractsError = $state<string | null>(null);

  let selectedContract = $state(routeFromPath(location.pathname).contract);
  let watchlistCollapsed = $state(false);
  let theme = $state<"dark" | "light">("dark");

  let accounts = $state<AccountDto[]>([]);
  let account = $state<AccountDto | null>(null);
  let summary = $state<AccountSummaryDto | null>(null);
  let summaryLoading = $state(false);
  let summaryError = $state<string | null>(null);
  let accountBusy = $state(false);
  let accountNotice = $state<string | null>(null);

  let positions = $state<PositionDto[]>([]);
  let orders = $state<OrderDto[]>([]);
  let fills = $state<FillDto[]>([]);
  let historyEntries = $state<HistoryEntryDto[]>([]);
  let ledger = $state<LedgerEntryDto[]>([]);
  let fillsCursor = $state<string | null>(null);
  let historyCursor = $state<string | null>(null);
  let ledgerCursor = $state<string | null>(null);
  let tablesLoading = $state(false);
  let tablesError = $state<string | null>(null);

  let activeTab = $state<WorkspaceTab>("positions");

  let backendMode = $state<"simulation" | "live" | null>(null);
  let feedState = $state<string | null>(null);
  let markStates = $state<Record<string, MarketStateView>>({});
  let candles = $state<CandleDto[]>([]);
  let candlesLoading = $state(false);
  let candlesError = $state<string | null>(null);
  let nowMs = $state(Date.now());
  let streamState = $state<DomainStreamState>("idle");

  // ── tiket order (Phase 7B) ─────────────────────────────────────
  let ticket = $state<TicketState>(initialTicketState);
  // Aksi tabel: cancel / close / protection
  let pendingOrderId = $state<string | null>(null);
  let pendingPositionId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let protectionTarget = $state<PositionDto | null>(null);
  let protectionError = $state<string | null>(null);
  let protectionPending = $state(false);
  let closeTarget = $state<PositionDto | null>(null);
  let closeError = $state<string | null>(null);
  let closePending = $state(false);
  /** Ditambah setelah sukses: tiket membersihkan size/TP/SL, bukan side/type/leverage. */
  let resetToken = $state(0);

  let domainStream: DomainStream | null = null;
  const marketStream = new MarketStream({
    url: wsUrl,
    onEvent: (event) => queueMarketEvent(event),
    onStateChange: () => {},
  });

  const marketState = $derived(markStates[selectedContract] ?? emptyMarketState(selectedContract));
  const selectedSpec = $derived(contracts.find((entry) => entry.contract === selectedContract) ?? null);
  const feedStatus = $derived<FeedStatus>(
    deriveFeedStatus({
      mode: backendMode,
      feedState,
      markStatus: marketState.markStatus,
      markReceivedAtMs: marketState.receivedAtMs,
      nowMs,
    }),
  );
  const stale = $derived(feedStatus === "STALE" || marketState.markStatus === "stale");

  // ── coalescing render pasar ────────────────────────────────────
  // Tick pasar bisa sangat sering; kita kumpulkan per frame agar tabel dan
  // panel lain tidak dirender ulang berkali-kali per detik.
  const pendingMarket: Array<{ type: string; contract: string; timestamp: number; data: Record<string, unknown> }> = [];
  let rafScheduled = false;

  function queueMarketEvent(event: { type: string; contract: string; timestamp: number; data: Record<string, unknown> }): void {
    pendingMarket.push(event);
    if (rafScheduled) {
      return;
    }
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      const batch = pendingMarket.splice(0);
      // Hanya keadaan TERBARU per (kontrak, jenis) yang diterapkan.
      const latest = new Map<string, (typeof batch)[number]>();
      for (const entry of batch) {
        latest.set(`${entry.contract}|${entry.type}`, entry);
      }
      for (const entry of latest.values()) {
        const current = markStates[entry.contract] ?? emptyMarketState(entry.contract);
        markStates = { ...markStates, [entry.contract]: applyMarketEvent(current, entry, Date.now()) };
        if (entry.type === "market.candle" && entry.contract === selectedContract) {
          applyLiveCandle(entry);
        }
      }
    });
  }

  /** Candle live hanya memperbarui candle terakhir, tidak menggambar ulang chart. */
  function applyLiveCandle(event: { data: Record<string, unknown>; timestamp: number }): void {
    const openTime = typeof event.data.openTime === "number" ? event.data.openTime : null;
    const close = typeof event.data.close === "string" ? event.data.close : null;
    if (openTime === null || close === null) {
      return;
    }
    const index = candles.findIndex((candle) => candle.openTime === openTime);
    if (index === -1) {
      candles = [...candles, { openTime, open: close, high: close, low: close, close, volume: "0", closed: false }];
      return;
    }
    const existing = candles[index]!;
    const next = [...candles];
    next[index] = { ...existing, close, high: close, low: close };
    candles = next;
  }

  // ── akun + tabel ───────────────────────────────────────────────
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh(): void {
    if (refreshTimer !== null) {
      return;
    }
    // Peristiwa domain bisa beruntun (satu perintah = banyak event); kita
    // memuat ulang ringkasan sekali saja per jendela singkat.
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshAccountAndTables();
    }, 120);
  }

  async function bootstrap(): Promise<void> {
    contractsLoading = true;
    try {
      const [contractList, health] = await Promise.all([api.contracts.list(), api.market.health()]);
      contracts = contractList.contracts;
      backendMode = health.mode;
      feedState = health.feed?.state ?? null;
      contractsError = null;
      if (!contracts.some((entry) => entry.contract === selectedContract) && contracts.length > 0) {
        selectContract(contracts[0]!.contract);
      }
    } catch (error) {
      contractsError = describe(error);
    } finally {
      contractsLoading = false;
    }

    try {
      const list = await api.accounts.list();
      accounts = list.accounts;
      account = accounts[0] ?? null;
    } catch (error) {
      summaryError = describe(error);
    }

    if (account !== null) {
      await refreshAccountAndTables();
      startDomainStream();
    }
    await refreshMarket();
    await loadCandles();
    connectMarketStream();
  }

  async function refreshMarket(): Promise<void> {
    try {
      const response = await api.market.state(contracts.map((entry) => entry.contract).slice(0, 20));
      backendMode = response.mode;
      const next: Record<string, MarketStateView> = { ...markStates };
      for (const entry of response.contracts) {
        const merged = mergeServerState(next[entry.contract] ?? null, entry);
        next[entry.contract] = { ...merged, receivedAtMs: merged.receivedAtMs ?? Date.now() };
      }
      markStates = next;
    } catch {
      // Pembaruan pasar bersifat best-effort; feed status tetap ditampilkan.
    }
  }

  async function refreshAccountAndTables(): Promise<void> {
    const current = account;
    if (current === null) {
      return;
    }
    tablesLoading = true;
    try {
      const [nextSummary, nextPositions, nextOrders, nextFills, nextHistory, nextLedger] = await Promise.all([
        api.accounts.summary(current.accountId),
        api.positions.list(current.accountId),
        api.orders.list(current.accountId),
        api.history.fills(current.accountId, { limit: 50 }),
        api.history.history(current.accountId, { limit: 50 }),
        api.history.ledger(current.accountId, { limit: 50 }),
      ]);
      summary = nextSummary;
      positions = nextPositions;
      orders = nextOrders;
      fills = nextFills.items;
      fillsCursor = nextFills.nextCursor;
      historyEntries = nextHistory.items;
      historyCursor = nextHistory.nextCursor;
      ledger = nextLedger.items;
      ledgerCursor = nextLedger.nextCursor;
      summaryError = null;
      tablesError = null;
    } catch (error) {
      tablesError = describe(error);
      summaryError = describe(error);
    } finally {
      tablesLoading = false;
    }
  }

  async function loadCandles(): Promise<void> {
    candlesLoading = true;
    try {
      const response = await api.market.candles(selectedContract, "5m", 300);
      candles = [...response.candles];
      candlesError = null;
    } catch (error) {
      candlesError = describe(error);
    } finally {
      candlesLoading = false;
    }
  }

  // ── realtime ───────────────────────────────────────────────────
  function startDomainStream(): void {
    const current = account;
    if (current === null) {
      return;
    }
    domainStream?.close();
    domainStream = new DomainStream({
      url: wsUrl,
      accountId: current.accountId,
      afterSeq: summary?.latestEventSeq ?? 0,
      onEvent: () => scheduleRefresh(),
      onStateChange: (state) => {
        streamState = state;
      },
      onResyncRequired: () => {
        // At-least-once: setelah diputus kita ambil snapshot BARU lalu lanjut
        // dari `latestEventSeq`-nya, bukan menebak dari seq lama.
        void resync();
      },
    });
    domainStream.connect();
  }

  async function resync(): Promise<void> {
    await refreshAccountAndTables();
    const current = account;
    if (current === null) {
      return;
    }
    domainStream?.close();
    domainStream = new DomainStream({
      url: wsUrl,
      accountId: current.accountId,
      afterSeq: summary?.latestEventSeq ?? 0,
      onEvent: () => scheduleRefresh(),
      onStateChange: (state) => {
        streamState = state;
      },
      onResyncRequired: () => {
        void resync();
      },
    });
    domainStream.connect();
  }

  function connectMarketStream(): void {
    marketStream.connect();
    marketStream.setContracts(visibleContracts());
  }

  function visibleContracts(): string[] {
    const list = contracts.slice(0, 12).map((entry) => entry.contract);
    return list.includes(selectedContract) ? list : [...list, selectedContract];
  }

  // ── aksi akun ──────────────────────────────────────────────────
  async function withCommand(
    operation: string,
    params: Record<string, string | number>,
    action: (commandId: string) => Promise<unknown>,
  ): Promise<void> {
    const key = actionKey(operation, params);
    // Retry AKSI YANG SAMA memakai commandId yang sama (idempotensi backend).
    const commandId = commands.for(key);
    accountBusy = true;
    try {
      await action(commandId);
      commands.settle(key);
      accountNotice = `${operation} berhasil`;
      await refreshAccountAndTables();
    } catch (error) {
      accountNotice = describe(error);
    } finally {
      accountBusy = false;
    }
  }

  function createAccount(initialBalance: string): void {
    void withCommand("create", { initialBalance }, async (commandId) => {
      const created = await api.accounts.create({ commandId, name: "paper", initialBalance });
      accounts = [created.account];
      account = created.account;
      startDomainStream();
    });
  }

  function deposit(amount: string): void {
    const current = account;
    if (current === null) return;
    void withCommand("deposit", { accountId: current.accountId, amount }, (commandId) =>
      api.accounts.deposit(current.accountId, { commandId, amount }),
    );
  }

  function withdraw(amount: string): void {
    const current = account;
    if (current === null) return;
    void withCommand("withdraw", { accountId: current.accountId, amount }, (commandId) =>
      api.accounts.withdraw(current.accountId, { commandId, amount }),
    );
  }

  function reset(amount: string): void {
    const current = account;
    if (current === null) return;
    void withCommand("reset", { accountId: current.accountId, balance: amount }, (commandId) =>
      api.accounts.reset(current.accountId, { commandId, balance: amount }),
    );
  }

  function selectAccount(accountId: string): void {
    const found = accounts.find((entry) => entry.accountId === accountId) ?? null;
    account = found;
    summary = null;
    positions = [];
    orders = [];
    fills = [];
    historyEntries = [];
    ledger = [];
    void refreshAccountAndTables();
    startDomainStream();
  }

  function selectContract(contract: string): void {
    selectedContract = contract;
    window.history.replaceState(null, "", pathForContract(contract));
    void refreshMarket();
    void loadCandles();
    marketStream.setContracts(visibleContracts());
  }

  function toggleTheme(): void {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  }

  async function loadMoreFills(): Promise<void> {
    const current = account;
    if (current === null || fillsCursor === null) return;
    const page = await api.history.fills(current.accountId, { limit: 50, after: fillsCursor });
    fills = [...fills, ...page.items];
    fillsCursor = page.nextCursor;
  }

  async function loadMoreHistory(): Promise<void> {
    const current = account;
    if (current === null || historyCursor === null) return;
    const page = await api.history.history(current.accountId, { limit: 50, after: historyCursor });
    historyEntries = [...historyEntries, ...page.items];
    historyCursor = page.nextCursor;
  }

  async function loadMoreLedger(): Promise<void> {
    const current = account;
    if (current === null || ledgerCursor === null) return;
    const page = await api.history.ledger(current.accountId, { limit: 50, after: Number(ledgerCursor) });
    ledger = [...ledger, ...page.items];
    ledgerCursor = page.nextCursor;
  }

  /**
   * Kirim order PAPER.
   *
   * Payload DIBEKUKAN saat pengiriman dimulai. Aksi logis yang sama memakai
   * commandId yang sama, sehingga retry tidak pernah menggandakan order.
   */
  async function submitOrder(input: {
    side: TicketSide;
    type: TicketType;
    size: string;
    leverage: string;
    limitPrice: string | null;
    takeProfitPrice: string | null;
    stopLossPrice: string | null;
  }): Promise<void> {
    const current = account;
    if (current === null) {
      actionError = "Buat/pilih akun paper terlebih dahulu";
      return;
    }
    const sizeNumber = parseContractCount(input.size);
    if (sizeNumber === null) {
      return;
    }
    const intent: OrderIntent = {
      contract: selectedContract,
      side: input.side,
      type: input.type,
      size: sizeNumber,
      price: input.limitPrice,
      leverage: input.leverage,
      timeInForce: defaultTimeInForce(input.type),
      reduceOnly: false,
      tpPrice: input.takeProfitPrice,
      slPrice: input.stopLossPrice,
    };
    const key = actionKey("submit_order", {
      accountId: current.accountId,
      contract: intent.contract,
      side: intent.side,
      type: intent.type,
      size: intent.size,
      leverage: intent.leverage,
      price: intent.price ?? "null",
      tp: intent.tpPrice ?? "null",
      sl: intent.slPrice ?? "null",
    });
    const commandId = commands.for(key);
    ticket = beginSubmit(ticket, { commandId, actionKey: key, intent });
    await sendOrder(current.accountId, commandId, intent, key);
  }

  /** Retry aksi yang belum pasti: commandId DAN payload dari state beku. */
  async function retryPending(): Promise<void> {
    const current = account;
    const frozen = ticket.frozen;
    if (current === null || frozen === null || !canRetry(ticket)) {
      return;
    }
    await sendOrder(current.accountId, frozen.commandId, frozen.intent, ticket.pendingKey ?? "");
  }

  async function sendOrder(
    accountId: string,
    commandId: string,
    intent: OrderIntent,
    actionKeyValue: string,
  ): Promise<void> {
    try {
      const response = await api.orders.submit(accountId, { commandId, ...intent });
      // Backend menolak secara definitif (order dipersist dengan status rejected).
      if (response.order.status === "rejected") {
        ticket = submitDefinitivelyFailed("INVALID_ORDER", response.order.rejectReason ?? "Order ditolak");
      } else {
        ticket = submitSucceeded();
        commands.settle(actionKeyValue);
        clearAfterSuccess();
      }
      // Rekonsiliasi lewat read model; respons HTTP saja tidak cukup.
      await refreshAccountAndTables();
    } catch (error) {
      if (error instanceof ApiError && isDefinitive(error.status)) {
        // 4xx bermakna: aksi selesai (gagal) secara pasti → payload boleh diubah.
        ticket = submitDefinitivelyFailed(error.code, friendlyError(error));
        commands.settle(actionKeyValue);
      } else {
        // Timeout/5xx/jaringan: backend MUNGKIN sudah commit. Jangan bilang gagal.
        ticket = submitUncertain(ticket, describe(error));
      }
      await refreshAccountAndTables();
    }
  }

  /**
   * Kebijakan sukses (didokumentasikan di docs/design/TERMINAL.md):
   * pertahankan `side`, `type`, `leverage` (pengguna sering mengulang arah yang
   * sama), kosongkan `size` dan TP/SL supaya tidak tidak sengaja terkirim ulang.
   */
  function clearAfterSuccess(): void {
    resetToken += 1;
  }

  async function cancelOrder(order: OrderDto): Promise<void> {
    const current = account;
    if (current === null) return;
    pendingOrderId = order.id;
    actionError = null;
    const key = actionKey("cancel_order", { accountId: current.accountId, orderId: order.id });
    const commandId = commands.for(key);
    try {
      await api.orders.cancel(current.accountId, order.id, { commandId });
      commands.settle(key);
      await refreshAccountAndTables();
    } catch (error) {
      if (!(error instanceof ApiError && isDefinitive(error.status))) {
        actionError = `Hasil pembatalan belum pasti — cek ulang. ${describe(error)}`;
      } else {
        actionError = friendlyError(error);
      }
      await refreshAccountAndTables();
    } finally {
      pendingOrderId = null;
    }
  }

  async function confirmClose(): Promise<void> {
    const current = account;
    const target = closeTarget;
    if (current === null || target === null) return;
    closePending = true;
    closeError = null;
    const key = actionKey("close_position", { accountId: current.accountId, positionId: target.id });
    const commandId = commands.for(key);
    try {
      await api.positions.close(current.accountId, target.id, { commandId });
      commands.settle(key);
      closeTarget = null;
      await refreshAccountAndTables();
    } catch (error) {
      closeError = friendlyError(error);
      await refreshAccountAndTables();
    } finally {
      closePending = false;
    }
  }

  async function applyProtection(input: {
    takeProfitPrice: string | null | undefined;
    stopLossPrice: string | null | undefined;
  }): Promise<void> {
    const current = account;
    const target = protectionTarget;
    if (current === null || target === null) return;
    protectionPending = true;
    protectionError = null;
    const key = actionKey("amend_protection", {
      accountId: current.accountId,
      positionId: target.id,
      tp: input.takeProfitPrice ?? "keep",
      sl: input.stopLossPrice ?? "keep",
    });
    const commandId = commands.for(key);
    try {
      await api.positions.amendProtection(current.accountId, target.id, {
        commandId,
        takeProfitPrice: input.takeProfitPrice,
        stopLossPrice: input.stopLossPrice,
      });
      commands.settle(key);
      protectionTarget = null;
      await refreshAccountAndTables();
    } catch (error) {
      protectionError = friendlyError(error);
      await refreshAccountAndTables();
    } finally {
      protectionPending = false;
    }
  }

  /** Cacah kontrak adalah INTEGER; konversi hanya dari string digit. */
  function parseContractCount(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      actionError = "Size harus cacah kontrak bulat";
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return parsed > 0 ? parsed : null;
  }

  /** 4xx (selain 409 konflik) = hasil pasti; 5xx/timeout/jaringan = belum pasti. */
  function isDefinitive(status: number): boolean {
    return status >= 400 && status < 500;
  }

  function friendlyError(error: unknown): string {
    if (!(error instanceof ApiError)) {
      return describe(error);
    }
    switch (error.code) {
      case "INSUFFICIENT_BALANCE":
        return `Saldo virtual tidak cukup. (${error.code})`;
      case "INVALID_ORDER":
        return `${error.message} (${error.code})`;
      case "IDEMPOTENCY_CONFLICT":
        return `commandId ini sudah dipakai dengan payload berbeda — periksa order yang ada, jangan ulangi dengan parameter yang diubah. (${error.code})`;
      case "NOT_AVAILABLE":
        return `Data pasar sedang tidak tersedia. (${error.code})`;
      case "NOT_FOUND":
        return `Data tidak ditemukan. (${error.code})`;
      default:
        return `${error.message} (${error.code})`;
    }
  }

  function describe(error: unknown): string {
    if (error instanceof ApiError) {
      return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  // ── lifecycle ──────────────────────────────────────────────────
  $effect(() => {
    void bootstrap();
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    const marketTimer = setInterval(() => void refreshMarket(), 5000);
    const onPop = (): void => {
      selectedContract = routeFromPath(location.pathname).contract;
      void loadCandles();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      clearInterval(timer);
      clearInterval(marketTimer);
      window.removeEventListener("popstate", onPop);
      domainStream?.close();
      marketStream.close();
    };
  });
</script>

<div class="terminal">
  <TopBar
    contract={selectedContract}
    {backendMode}
    {feedStatus}
    feedDetail={`feed=${feedState ?? "—"} · stream=${streamState} · marks ${marketState.markStatus}`}
    onToggleTheme={toggleTheme}
    onToggleWatchlist={() => (watchlistCollapsed = !watchlistCollapsed)}
  />

  <main class="grid" data-collapsed={watchlistCollapsed}>
    <Watchlist
      {contracts}
      selected={selectedContract}
      states={markStates}
      loading={contractsLoading}
      error={contractsError}
      collapsed={watchlistCollapsed}
      onSelect={selectContract}
    />

    <div class="center">
      <MarketHeader
        contract={selectedContract}
        spec={selectedSpec}
        state={marketState}
        {nowMs}
        {stale}
        loading={candlesLoading}
      />
      <PriceChart
        contract={selectedContract}
        interval="5m"
        {candles}
        loading={candlesLoading}
        error={candlesError}
      />
    </div>

    <div class="right">
      <AccountPanel
        {account}
        {summary}
        {accounts}
        loading={summaryLoading}
        error={summaryError}
        busy={accountBusy}
        notice={accountNotice}
        onSelectAccount={selectAccount}
        onCreate={createAccount}
        onDeposit={deposit}
        onWithdraw={withdraw}
        onReset={reset}
      />
      <OrderTicket
        contract={selectedContract}
        spec={selectedSpec}
        market={marketState}
        availableBalance={summary?.availableBalance ?? null}
        {ticket}
        resetToken={resetToken}
        onSubmit={(input) => void submitOrder(input)}
        onRetryPending={() => void retryPending()}
        onAbandonPending={() => (ticket = abandon())}
      />
      {#if protectionTarget !== null}
        <ProtectionForm
          position={protectionTarget}
          pending={protectionPending}
          error={protectionError}
          onApply={(input) => void applyProtection(input)}
          onCancel={() => (protectionTarget = null)}
        />
      {/if}
      {#if closeTarget !== null}
        <ClosePositionForm
          position={closeTarget}
          executableQuote={{ bid: marketState?.bestBid ?? null, ask: marketState?.bestAsk ?? null }}
          pending={closePending}
          error={closeError}
          onConfirm={() => void confirmClose()}
          onCancel={() => (closeTarget = null)}
        />
      {/if}
    </div>
  </main>

  <footer class="bottom">
    <BottomWorkspace
      active={activeTab}
      {positions}
      {orders}
      {fills}
      history={historyEntries}
      {ledger}
      loading={tablesLoading}
      error={tablesError}
      {stale}
      fillsHasMore={fillsCursor !== null}
      historyHasMore={historyCursor !== null}
      ledgerHasMore={ledgerCursor !== null}
      onSelectTab={(tab) => (activeTab = tab)}
      onLoadMoreFills={() => void loadMoreFills()}
      onLoadMoreHistory={() => void loadMoreHistory()}
      onLoadMoreLedger={() => void loadMoreLedger()}
      pendingOrderId={pendingOrderId}
      pendingPositionId={pendingPositionId}
      actionError={actionError}
      onCancelOrder={(order) => void cancelOrder(order)}
      onClosePosition={(position) => {
        closeTarget = position;
        closeError = null;
      }}
      onEditProtection={(position) => {
        protectionTarget = position;
        protectionError = null;
      }}
    />
  </footer>
</div>

<style>
  .terminal {
    display: grid;
    grid-template-rows: auto 1fr 300px;
    height: 100vh;
    overflow: hidden;
  }
  .grid {
    display: grid;
    grid-template-columns: 212px minmax(0, 1fr) 320px;
    gap: 6px;
    padding: 6px;
    min-height: 0;
    overflow: hidden;
  }
  .grid[data-collapsed="true"] { grid-template-columns: minmax(0, 1fr) 320px; }
  .center { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 6px; min-height: 0; overflow: hidden; }
  .right { display: grid; grid-template-rows: auto auto; gap: 6px; align-content: start; overflow: auto; }
  .bottom { padding: 0 6px 6px; min-height: 0; overflow: hidden; }

  @media (max-width: 1400px) {
    .grid { grid-template-columns: 176px minmax(0, 1fr) 280px; }
  }
  @media (max-width: 1180px) {
    .grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
    .right { grid-template-rows: auto; }
  }
</style>
