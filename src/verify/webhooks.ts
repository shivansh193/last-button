// PayPal webhook intake: verify the signature with PayPal, keep payment events by link ID.
import { pp } from "../paypal/client.js";

export interface PaymentEvent {
  eventId: string;
  receivedAt: string;
  linkId: string;
  transactionId: string | null;
  gross: string | null;
  verified: boolean;
}

const byLink = new Map<string, PaymentEvent[]>();
const listeners = new Set<(e: PaymentEvent) => void>();
export const onPaymentEvent = (fn: (e: PaymentEvent) => void) => (listeners.add(fn), () => listeners.delete(fn));

export async function verifySignature(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const h = (k: string) => String(headers[k] ?? "");
  const res = await pp("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: body,
  }).catch(() => null);
  return res?.body?.verification_status === "SUCCESS";
}

export function recordEvent(e: any, verified: boolean): PaymentEvent | null {
  if (e?.event_type !== "CHECKOUT.PAYMENT-RESOURCE.PAYMENT-COMPLETED") return null;
  const r = e.resource ?? {};
  const ev: PaymentEvent = {
    eventId: e.id,
    receivedAt: new Date().toISOString(),
    linkId: r.payment_resource_id,
    transactionId: r.transaction_id ?? null,
    gross: r.gross_amount?.value ?? null,
    verified,
  };
  if (!ev.linkId) return null;
  const list = byLink.get(ev.linkId) ?? [];
  if (!list.some((x) => x.eventId === ev.eventId)) list.push(ev);
  byLink.set(ev.linkId, list.slice(-20));
  for (const fn of listeners) fn(ev);
  return ev;
}

export function findEvent(linkId: string, transactionId: string | null): PaymentEvent | null {
  const list = byLink.get(linkId) ?? [];
  return list.find((e) => transactionId && e.transactionId === transactionId) ?? null;
}
