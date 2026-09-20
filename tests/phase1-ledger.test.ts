import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { LedgerRepository } from "../apps/server/src/repositories/ledger-repository.js";
import { integrityReport } from "../apps/server/src/repositories/integrity.js";
import { NotFoundError, ValidationError } from "../apps/server/src/db/errors.js";
import { openDatabase } from "../apps/server/src/db/database.js";
import { openTempDatabase, tempDatabasePath, type TempDatabase } from "./helpers/db.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function setup(initialBalance = "10000"): {
  db: TempDatabase;
  accounts: AccountRepository;
  ledger: LedgerRepository;
  accountId: string;
} {
  const db = openTempDatabase();
  cleanups.push(db.cleanup);
  const accounts = new AccountRepository(db.connection);
  const ledger = new LedgerRepository(db.connection);
  const account = accounts.create({
    name: "paper",
    mode: "simulation",
    initialBalance,
    createdAtMs: 1_000,
  });
  return { db, accounts, ledger, accountId: account.id };
}

describe("6. append mengubah saldo cache tepat sekali", () => {
  test("satu deposit menambah saldo sekali dan mencatat satu entri", () => {
    const { db, ledger, accountId } = setup("1000");

    const result = ledger.append({
      accountId,
      tsMs: 2_000,
      type: "deposit",
      amount: "250.5",
      idempotencyKey: "deposit-1",
    });

    expect(result.duplicate).toBe(false);
    expect(result.balances.walletBalance.toString()).toBe("1250.5");
    expect(result.entry.balanceAfter.toString()).toBe("1250.5");
    expect(result.entry.seq).toBe(1);
    expect(ledger.list(accountId)).toHaveLength(1);
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("1250.5");
    expect(db.connection.sqlite.query("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 1 });
  });

  test("append gagal pada akun tak dikenal tidak menulis apa pun", () => {
    const { db, ledger } = setup("1000");

    expect(() =>
      ledger.append({
        accountId: "tidak-ada",
        tsMs: 2_000,
        type: "deposit",
        amount: "10",
        idempotencyKey: "ghost",
      }),
    ).toThrow(NotFoundError);

    expect(db.connection.sqlite.query("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 0 });
  });
});

describe("7. idempotency key ganda tidak menggandakan mutasi", () => {
  test("submit ulang mengembalikan entri lama dan saldo tidak berubah", () => {
    const { ledger, accountId } = setup("1000");
    const input = {
      accountId,
      tsMs: 2_000,
      type: "fee" as const,
      amount: "-0.006",
      idempotencyKey: "fee:BTC_USDT:fill-1",
    };

    const first = ledger.append(input);
    const second = ledger.append(input);
    const third = ledger.append({ ...input, tsMs: 9_999, amount: "-999" });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);

    // Mutasi tepat sekali.
    expect(ledger.list(accountId)).toHaveLength(1);
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("999.994");
    expect(ledger.balances(accountId).feesPaid.toString()).toBe("0.006");

    // Entri yang dikembalikan identik dengan yang asli, bukan versi baru.
    expect(second.entry.seq).toBe(first.entry.seq);
    expect(third.entry.amount.toString()).toBe("-0.006");
  });

  test("idempotencyKey kosong ditolak", () => {
    const { ledger, accountId } = setup();
    expect(() =>
      ledger.append({ accountId, tsMs: 1, type: "deposit", amount: "1", idempotencyKey: "  " }),
    ).toThrow(ValidationError);
  });
});

describe("8 & 9. ledger menolak UPDATE dan DELETE", () => {
  test("UPDATE ditolak oleh trigger database", () => {
    const { db, ledger, accountId } = setup("1000");
    ledger.append({
      accountId,
      tsMs: 2_000,
      type: "deposit",
      amount: "10",
      idempotencyKey: "d1",
    });

    expect(() =>
      db.connection.sqlite.prepare("UPDATE ledger SET amount = '99999.00000000'").run(),
    ).toThrow(/append-only/);

    // Nilai tidak berubah.
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("1010");
  });

  test("DELETE ditolak oleh trigger database", () => {
    const { db, ledger, accountId } = setup("1000");
    ledger.append({
      accountId,
      tsMs: 2_000,
      type: "deposit",
      amount: "10",
      idempotencyKey: "d1",
    });

    expect(() => db.connection.sqlite.prepare("DELETE FROM ledger").run()).toThrow(/append-only/);
    expect(ledger.list(accountId)).toHaveLength(1);
  });

  test("market_events juga tidak bisa diubah/dihapus", () => {
    const { db } = setup();
    db.connection.sqlite
      .prepare(
        "INSERT INTO market_events (provider, channel, contract, event_ts, dedupe_key, payload_json, ingested_at) VALUES ('g','c','BTC_USDT',1,'k','{}',1)",
      )
      .run();
    expect(() =>
      db.connection.sqlite.prepare("UPDATE market_events SET payload_json = '{\"x\":1}'").run(),
    ).toThrow(/append-only/);
    expect(() => db.connection.sqlite.prepare("DELETE FROM market_events").run()).toThrow(
      /append-only/,
    );
  });

  test("koreksi dilakukan lewat entri adjustment baru, bukan UPDATE", () => {
    const { ledger, accountId } = setup("1000");
    ledger.append({ accountId, tsMs: 1, type: "deposit", amount: "100", idempotencyKey: "a" });
    ledger.append({ accountId, tsMs: 2, type: "adjustment", amount: "-30", idempotencyKey: "b" });

    expect(ledger.list(accountId)).toHaveLength(2);
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("1070");
  });
});

describe("10. rebuildBalances merekonstruksi cache persis", () => {
  test("rebuild dari ledger mengoreksi cache yang rusak", () => {
    const { db, ledger, accountId } = setup("1000");
    ledger.append({ accountId, tsMs: 1, type: "deposit", amount: "5000.25", idempotencyKey: "a" });
    ledger.append({ accountId, tsMs: 2, type: "fee", amount: "-0.006", idempotencyKey: "b" });
    ledger.append({ accountId, tsMs: 3, type: "pnl_realized", amount: "12.345678", idempotencyKey: "c" });
    ledger.append({ accountId, tsMs: 4, type: "withdrawal", amount: "-100", idempotencyKey: "d" });
    ledger.append({ accountId, tsMs: 5, type: "margin_lock", marginDelta: "50", idempotencyKey: "e" });

    const expectedWallet = new Decimal("1000").plus("5000.25").minus("0.006").plus("12.345678").minus("100");

    // Cache saat ini benar.
    const before = ledger.verifyBalances(accountId);
    expect(before.cacheMatches).toBe(true);
    expect(before.chainMismatch).toBeNull();

    // Rusak cache langsung (diizinkan: ini cache, bukan ledger).
    db.connection.sqlite
      .prepare("UPDATE account_balances SET wallet_balance = '999999.00000000', fees_paid = '0.00000000'")
      .run();

    const corrupted = ledger.verifyBalances(accountId);
    expect(corrupted.cacheMatches).toBe(false);
    // verifyBalances TIDAK menulis.
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("999999");

    // integrityReport mendeteksi divergensi cache.
    const report = integrityReport(db.connection);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.cacheMatches).toBe(false);
    expect(report.mismatches[0]!.walletBalance).toBe(expectedWallet.toFixed(8));

    // Rebuild memulihkan.
    const rebuilt = ledger.rebuildBalances(accountId);
    expect(rebuilt.balances.walletBalance.eq(expectedWallet)).toBe(true);
    expect(rebuilt.balances.feesPaid.toString()).toBe("0.006");
    expect(rebuilt.balances.usedMargin.toString()).toBe("50");
    expect(rebuilt.cacheMatches).toBe(false); // dibaca sebelum ditulis

    // Setelah rebuild, cache == turunan ledger.
    const after = ledger.verifyBalances(accountId);
    expect(after.cacheMatches).toBe(true);
    expect(ledger.balances(accountId).walletBalance.eq(expectedWallet)).toBe(true);
    expect(integrityReport(db.connection).mismatches).toHaveLength(0);
  });

  test("rebuild deterministik dan tidak bergantung cache", () => {
    const { db, ledger, accountId } = setup("1000");
    ledger.append({ accountId, tsMs: 1, type: "deposit", amount: "123.45678901", idempotencyKey: "a" });
    ledger.append({ accountId, tsMs: 2, type: "funding", amount: "-0.00000001", idempotencyKey: "b" });

    const first = ledger.rebuildBalances(accountId);
    db.connection.sqlite.prepare("UPDATE account_balances SET wallet_balance = '0.00000000'").run();
    const second = ledger.rebuildBalances(accountId);

    expect(second.balances.walletBalance.eq(first.balances.walletBalance)).toBe(true);
    expect(ledger.balances(accountId).walletBalance.eq(first.balances.walletBalance)).toBe(true);
  });
});

describe("11. nilai negatif (rebate maker)", () => {
  test("fee negatif menambah saldo dan membuat fees_paid negatif", () => {
    const { ledger, accountId } = setup("1000");

    // amount positif pada tipe fee = rebate: trader menerima.
    ledger.append({
      accountId,
      tsMs: 1,
      type: "fee",
      amount: "0.0008",
      idempotencyKey: "rebate-1",
      meta: { liquidity: "maker" },
    });

    const balances = ledger.balances(accountId);
    expect(balances.walletBalance.toString()).toBe("1000.0008");
    expect(balances.feesPaid.toString()).toBe("-0.0008");

    // Biaya normal mengurangi saldo dan menambah fees_paid.
    ledger.append({
      accountId,
      tsMs: 2,
      type: "fee",
      amount: "-0.006",
      idempotencyKey: "taker-1",
      meta: { liquidity: "taker" },
    });
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("999.9948");
    expect(ledger.balances(accountId).feesPaid.toString()).toBe("0.0052");
  });

  test("withdrawal negatif didukung dan rebuild tetap konsisten", () => {
    const { ledger, accountId } = setup("1000");
    ledger.append({ accountId, tsMs: 1, type: "withdrawal", amount: "-250.75", idempotencyKey: "w" });

    expect(ledger.balances(accountId).walletBalance.toString()).toBe("749.25");
    const verified = ledger.verifyBalances(accountId);
    expect(verified.chainMismatch).toBeNull();
    expect(verified.cacheMatches).toBe(true);
  });
});

describe("12. mutasi bersamaan tidak kehilangan update", () => {
  test("penulis kedua menunggu lock, bukan menimpa (BEGIN IMMEDIATE)", () => {
    const path = tempDatabasePath();
    const writerA = openDatabase({ path, busyTimeoutMs: 5_000 });
    const writerB = openDatabase({ path, busyTimeoutMs: 50 });
    cleanups.push(() => {
      try {
        writerA.close();
      } catch {
        /* sudah tertutup */
      }
      try {
        writerB.close();
      } catch {
        /* sudah tertutup */
      }
    });

    const accounts = new AccountRepository(writerA);
    const account = accounts.create({
      name: "concurrent",
      mode: "simulation",
      initialBalance: "1000",
      createdAtMs: 1,
    });
    const ledgerA = new LedgerRepository(writerA);
    const ledgerB = new LedgerRepository(writerB);

    // A memegang write-lock.
    writerA.sqlite.exec("BEGIN IMMEDIATE");
    ledgerA.append({
      accountId: account.id,
      tsMs: 2,
      type: "deposit",
      amount: "10",
      idempotencyKey: "a",
    });

    // B tidak boleh bisa menulis selama A memegang lock.
    expect(() =>
      ledgerB.append({
        accountId: account.id,
        tsMs: 3,
        type: "deposit",
        amount: "20",
        idempotencyKey: "b",
      }),
    ).toThrow();

    writerA.sqlite.exec("COMMIT");

    // Setelah A commit, B berhasil dan TIDAK menimpa hasil A.
    const bResult = ledgerB.append({
      accountId: account.id,
      tsMs: 3,
      type: "deposit",
      amount: "20",
      idempotencyKey: "b",
    });
    expect(bResult.balances.walletBalance.toString()).toBe("1030");

    expect(ledgerA.balances(account.id).walletBalance.toString()).toBe("1030");
    expect(ledgerA.list(account.id)).toHaveLength(2);
  });
});

describe("13. kegagalan rollback seluruh mutasi finansial", () => {
  test("exception di tengah transaksi membatalkan entri ledger dan cache", () => {
    const { db, ledger, accountId } = setup("1000");

    expect(() =>
      db.connection.transaction(() => {
        ledger.append({
          accountId,
          tsMs: 2,
          type: "deposit",
          amount: "500",
          idempotencyKey: "will-rollback",
        });
        throw new Error("kegagalan setelah penulisan");
      }),
    ).toThrow("kegagalan setelah penulisan");

    // Tidak ada entri, saldo tidak berubah.
    expect(ledger.list(accountId)).toHaveLength(0);
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("1000");
    expect(db.connection.sqlite.query("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 0 });
  });

  test("pelanggaran unique idempotency key membatalkan seluruh transaksi", () => {
    const { db, ledger, accountId } = setup("1000");
    ledger.append({ accountId, tsMs: 1, type: "deposit", amount: "10", idempotencyKey: "dup" });

    // Sisipkan langsung dengan kunci yang sama di dalam transaksi yang juga
    // melakukan mutasi lain: semuanya harus batal.
    expect(() =>
      db.connection.transaction(() => {
        db.connection.sqlite
          .prepare(
            "INSERT INTO ledger (account_id, ts, type, amount, margin_delta, reserved_delta, balance_after, idempotency_key, meta_json) VALUES (?, 2, 'deposit', '1.00000000', '0.00000000', '0.00000000', '1011.00000000', 'dup', '{}')",
          )
          .run(accountId);
        ledger.append({
          accountId,
          tsMs: 3,
          type: "deposit",
          amount: "777",
          idempotencyKey: "other",
        });
      }),
    ).toThrow();

    expect(ledger.list(accountId)).toHaveLength(1);
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("1010");
  });
});

describe("validasi tipe ledger", () => {
  test("tipe non-wallet tidak boleh membawa amount", () => {
    const { ledger, accountId } = setup();
    expect(() =>
      ledger.append({
        accountId,
        tsMs: 1,
        type: "margin_lock",
        amount: "10",
        marginDelta: "10",
        idempotencyKey: "bad",
      }),
    ).toThrow(ValidationError);
  });

  test("marginDelta hanya untuk tipe margin", () => {
    const { ledger, accountId } = setup();
    expect(() =>
      ledger.append({
        accountId,
        tsMs: 1,
        type: "deposit",
        amount: "10",
        marginDelta: "5",
        idempotencyKey: "bad2",
      }),
    ).toThrow(ValidationError);
  });

  test("margin_lock menggerakkan used_margin tanpa mengubah wallet", () => {
    const { ledger, accountId } = setup("1000");
    ledger.append({
      accountId,
      tsMs: 1,
      type: "margin_lock",
      marginDelta: "80",
      idempotencyKey: "lock",
      refType: "position",
      refId: "pos-1",
    });
    const balances = ledger.balances(accountId);
    expect(balances.walletBalance.toString()).toBe("1000");
    expect(balances.usedMargin.toString()).toBe("80");

    ledger.append({
      accountId,
      tsMs: 2,
      type: "margin_release",
      marginDelta: "-80",
      idempotencyKey: "release",
    });
    expect(ledger.balances(accountId).usedMargin.toString()).toBe("0");
    expect(ledger.balances(accountId).walletBalance.toString()).toBe("1000");
  });

  test("ledger list mendukung afterSeq untuk replay", () => {
    const { ledger, accountId } = setup("1000");
    for (let i = 0; i < 5; i += 1) {
      ledger.append({
        accountId,
        tsMs: i + 1,
        type: "deposit",
        amount: "1",
        idempotencyKey: `s-${i}`,
      });
    }
    const all = ledger.list(accountId);
    const tail = ledger.list(accountId, { afterSeq: all[2]!.seq });
    expect(tail.map((entry) => entry.idempotencyKey)).toEqual(["s-3", "s-4"]);
  });
});
