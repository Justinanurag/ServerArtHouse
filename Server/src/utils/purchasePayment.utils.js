/**
 * Normalize cash vs credit purchase payment fields.
 * Credit purchases are never marked paid; full amount stays outstanding (due).
 */
export function resolvePurchasePaymentFields({
  amount,
  paymentMode,
  status,
  purchaseType,
  paidAmount,
  dueAmount,
} = {}) {
  const total = Math.max(0, Number(amount) || 0);
  const typeRaw = String(purchaseType ?? "").trim().toLowerCase();
  const modeRaw = String(paymentMode ?? "").trim();
  const isCredit =
    typeRaw === "credit" ||
    modeRaw.toLowerCase() === "credit" ||
    String(status ?? "")
      .trim()
      .toLowerCase() === "due";

  if (isCredit) {
    return {
      purchaseType: "credit",
      paymentMode: "Credit",
      status: "due",
      paidAmount: 0,
      dueAmount: total,
    };
  }

  const statusNorm = String(status ?? "paid")
    .trim()
    .toLowerCase();
  const allowedStatus = new Set([
    "draft",
    "pending",
    "paid",
    "partial",
    "cancelled",
    "due",
  ]);
  const nextStatus = allowedStatus.has(statusNorm) ? statusNorm : "paid";

  const allowedModes = ["Cash", "UPI", "Card", "Bank", "Credit", "Other"];
  let nextMode = "Cash";
  if (modeRaw) {
    if (modeRaw.toUpperCase() === "UPI") nextMode = "UPI";
    else if (modeRaw.toUpperCase() === "MULTI") nextMode = "Other";
    else {
      const hit = allowedModes.find(
        (m) => m.toLowerCase() === modeRaw.toLowerCase(),
      );
      nextMode = hit || "Cash";
    }
  }

  let paid = Number(paidAmount);
  let due = Number(dueAmount);
  if (!Number.isFinite(paid) || !Number.isFinite(due)) {
    if (nextStatus === "paid") {
      paid = total;
      due = 0;
    } else if (nextStatus === "partial") {
      paid = Number.isFinite(paid) ? Math.min(total, Math.max(0, paid)) : 0;
      due = Math.max(0, total - paid);
    } else {
      paid = Number.isFinite(paid) ? Math.max(0, paid) : 0;
      due = Number.isFinite(due) ? Math.max(0, due) : total;
    }
  } else {
    paid = Math.min(total, Math.max(0, paid));
    due = Math.max(0, due);
  }

  return {
    purchaseType: "cash",
    paymentMode: nextMode,
    status: nextStatus,
    paidAmount: paid,
    dueAmount: due,
  };
}
