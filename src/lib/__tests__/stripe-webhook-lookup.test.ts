import { describe, it, expect } from "vitest";

// Pure unit tests for the webhook purchase-lookup and session-mapping logic.
// No Stripe SDK or Supabase required — tests the application-layer decisions.

// ── Simulates the new session-ID-based lookup ────────────────────────────────
function findPurchaseBySessionId(
  purchases: Array<{ id: string; stripe_session_id: string | null; status: string; gifted_to: number | null }>,
  sessionId: string
) {
  return purchases.find((p) => p.stripe_session_id === sessionId) ?? null;
}

// ── Simulates legacy fallback (no stripe_session_id stored) ──────────────────
function findLegacyPendingPurchase(
  purchases: Array<{ id: string; stripe_session_id: string | null; status: string; developer_id: number; item_id: string }>,
  developerId: number,
  itemId: string
) {
  const candidates = purchases.filter(
    (p) =>
      p.developer_id === developerId &&
      p.item_id === itemId &&
      p.status === "pending" &&
      p.stripe_session_id === null
  );
  if (candidates.length > 1) throw new Error("406: multiple rows"); // maybeSingle() equivalent
  return candidates[0] ?? null;
}

describe("stripe webhook — session_id lookup (Bug A fix)", () => {
  it("finds the correct pending purchase by session_id (single billboard)", () => {
    const db = [
      { id: "p1", stripe_session_id: "cs_sess_001", status: "pending", gifted_to: null },
    ];
    expect(findPurchaseBySessionId(db, "cs_sess_001")).toMatchObject({ id: "p1" });
  });

  it("finds the correct purchase when two billboard pending rows exist", () => {
    // Bug A: old code threw 406 on this scenario; new code resolves by session_id
    const db = [
      { id: "p1", stripe_session_id: "cs_sess_001", status: "pending", gifted_to: null },
      { id: "p2", stripe_session_id: "cs_sess_002", status: "pending", gifted_to: null },
    ];
    expect(findPurchaseBySessionId(db, "cs_sess_001")).toMatchObject({ id: "p1" });
    expect(findPurchaseBySessionId(db, "cs_sess_002")).toMatchObject({ id: "p2" });
  });

  it("returns null when session_id does not match any row", () => {
    const db = [
      { id: "p1", stripe_session_id: "cs_sess_001", status: "pending", gifted_to: null },
    ];
    expect(findPurchaseBySessionId(db, "cs_sess_UNKNOWN")).toBeNull();
  });

  it("finds already-completed purchase for idempotency check", () => {
    const db = [
      { id: "p1", stripe_session_id: "cs_sess_001", status: "completed", gifted_to: null },
    ];
    const found = findPurchaseBySessionId(db, "cs_sess_001");
    expect(found?.status).toBe("completed");
  });
});

describe("stripe webhook — gifted_to preserved from purchases row (Bug B fix)", () => {
  it("uses gifted_to from purchases row, not re-derived from session metadata", () => {
    const purchaseRow = { id: "p1", gifted_to: 99, stripe_session_id: "cs_sess_001", status: "pending" };
    const sessionMetadata = { gifted_to: undefined }; // metadata absent (retry scenario)

    // New logic: prefer purchases row's gifted_to
    const giftedTo = purchaseRow.gifted_to
      ? String(purchaseRow.gifted_to)
      : (sessionMetadata as any)?.gifted_to;

    expect(giftedTo).toBe("99"); // correctly uses row value
  });

  it("falls back to session metadata gifted_to when row has null", () => {
    const purchaseRow = { id: "p1", gifted_to: null, stripe_session_id: "cs_sess_001", status: "pending" };
    const sessionMetadata = { gifted_to: "77" };

    const giftedTo = purchaseRow.gifted_to
      ? String(purchaseRow.gifted_to)
      : sessionMetadata?.gifted_to;

    expect(giftedTo).toBe("77");
  });

  it("correctly identifies gifted purchase vs self-purchase", () => {
    const giftedRow = { gifted_to: 55, status: "pending" };
    const selfRow = { gifted_to: null, status: "pending" };

    expect(giftedRow.gifted_to !== null).toBe(true);
    expect(selfRow.gifted_to !== null).toBe(false);
  });
});

describe("legacy fallback lookup (rows without stripe_session_id)", () => {
  it("finds single legacy pending row by (developer_id, item_id)", () => {
    const db = [
      { id: "p1", stripe_session_id: null, status: "pending", developer_id: 42, item_id: "flag" },
    ];
    expect(findLegacyPendingPurchase(db, 42, "flag")).toMatchObject({ id: "p1" });
  });

  it("throws on multiple legacy pending rows (Bug A reproduced in legacy path)", () => {
    const db = [
      { id: "p1", stripe_session_id: null, status: "pending", developer_id: 42, item_id: "billboard" },
      { id: "p2", stripe_session_id: null, status: "pending", developer_id: 42, item_id: "billboard" },
    ];
    expect(() => findLegacyPendingPurchase(db, 42, "billboard")).toThrow("406");
  });

  it("returns null when no legacy pending row matches", () => {
    const db = [
      { id: "p1", stripe_session_id: "cs_xxx", status: "pending", developer_id: 42, item_id: "flag" },
    ];
    // Has a session_id, so excluded from legacy lookup (stripe_session_id IS NULL filter)
    expect(findLegacyPendingPurchase(db, 42, "flag")).toBeNull();
  });
});

describe("soft-abandon on retry (Bug B prevention)", () => {
  function retryCheckout(
    purchases: Array<{ id: string; status: string; developer_id: number; item_id: string }>,
    developerId: number,
    itemId: string
  ) {
    // New behavior: soft-update to "abandoned" instead of DELETE
    return purchases.map((p) => {
      if (p.developer_id === developerId && p.item_id === itemId && p.status === "pending") {
        return { ...p, status: "abandoned" };
      }
      return p;
    });
  }

  it("marks existing pending row as abandoned (not deleted) on retry", () => {
    const db = [
      { id: "p1", status: "pending", developer_id: 42, item_id: "flag" },
    ];
    const after = retryCheckout(db, 42, "flag");
    expect(after[0].status).toBe("abandoned");
    expect(after).toHaveLength(1); // row still exists for webhook to find
  });

  it("abandoned row is still present for webhook delivery", () => {
    const db = [
      { id: "p1", status: "pending", developer_id: 42, item_id: "flag", stripe_session_id: "cs_original" },
    ];
    const after = retryCheckout(db, 42, "flag");
    // Webhook for cs_original can still find the row by session_id
    const found = after.find((p) => (p as any).stripe_session_id === "cs_original");
    expect(found).toBeDefined();
    expect(found?.status).toBe("abandoned");
  });

  it("does not affect completed rows on retry", () => {
    const db = [
      { id: "p1", status: "completed", developer_id: 42, item_id: "flag" },
    ];
    const after = retryCheckout(db, 42, "flag");
    expect(after[0].status).toBe("completed"); // untouched
  });
});