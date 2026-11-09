// Shared types for scanning, reconstruction, migration and verification.

export type ButtonKind =
  | "buy_now" // cmd=_xclick
  | "add_to_cart" // cmd=_cart&add=1
  | "view_cart" // cmd=_cart&display=1
  | "cart_upload" // cmd=_cart&upload=1
  | "hosted" // cmd=_s-xclick + hosted_button_id (Buy Now / Pay Now image)
  | "encrypted" // cmd=_s-xclick + encrypted blob
  | "donate" // cmd=_donations, or a hosted button showing a Donate image
  | "subscribe" // cmd=_xclick-subscriptions, or a hosted button showing a Subscribe image
  | "unknown";

export interface DetectedButton {
  id: string; // stable within a scan: "<pageIndex>-<index>"
  pageUrl: string;
  pagePath: string; // path relative to the scanned origin, e.g. "shop.html"
  index: number; // order on its page
  element: "form" | "link";
  kind: ButtonKind;
  affected: boolean;
  reason: string; // plain English
  cmd: string | null;
  sandbox: boolean;
  jsInjected: boolean;
  fields: Record<string, string>; // all named inputs (hidden + visible), or link query params
  selectOptions: Record<string, { value: string; text: string }[]>; // os0 -> options
  visibleInputs: string[]; // names of non-hidden inputs (e.g. a visible quantity box)
  imageSrc: string | null;
  imageAlt: string | null;
  html: string; // outer HTML of the button (trimmed)
  context: string; // nearby page text (heading + surrounding block), for AI
  fingerprint: string; // used by the runtime swap script to find this button again
}

export type Source = "html_field" | "page_context" | "default" | "owner" | "unknown";

export interface Provenance {
  source: Source;
  field?: string; // which WPS field it came from
  quote?: string; // verbatim snippet from the page (page_context)
  confidence: number; // 0..1
  note?: string;
  confirmed?: boolean; // the owner clicked confirm (or edited)
}

export interface SpecField<T> {
  value: T | null;
  prov: Provenance;
}

export interface VariantOption {
  label: string;
  price: string | null; // null = same as the base price
}

export interface Variants {
  dimension: string;
  options: VariantOption[];
}

export interface Shipping {
  first: string;
  additional: string | null;
}

export interface QuantityRule {
  adjustable: boolean;
  max: number | null;
}

export interface LinkSpec {
  name: SpecField<string>;
  description: SpecField<string>;
  price: SpecField<string>;
  currency: SpecField<string>;
  variants: SpecField<Variants>;
  shipping: SpecField<Shipping>;
  taxPercent: SpecField<string>;
  quantity: SpecField<QuantityRule>;
  returnUrl: SpecField<string>;
}

export type SpecKey = keyof LinkSpec;

export interface Reconstruction {
  spec: LinkSpec;
  needsOwner: SpecKey[]; // fields the owner must confirm before a link is created
  notes: string[]; // plain-English change notes
  usedAI: boolean;
  aiModel?: string;
  aiError?: string;
}

export interface PageResult {
  url: string;
  path: string;
  status: number | "error";
  rendered: boolean;
  buttons: number;
  error?: string;
}

export interface ScanResult {
  id: string;
  input: { kind: "url"; url: string } | { kind: "html"; label: string };
  startedAt: string;
  finishedAt?: string;
  pages: PageResult[];
  buttons: DetectedButton[];
  skipped: string[]; // robots.txt or limit
}

export type RowStatus =
  | "unaffected" // Donate / Subscribe: left alone
  | "needs_owner" // waiting for one-click confirmation
  | "ready" // spec complete, no link yet
  | "link_created"
  | "verifying"
  | "verified" // a sandbox payment matched
  | "mismatch" // paid amount or variant did not match
  | "failed"
  | "not_migratable"; // e.g. view-cart button: nothing to rebuild

export interface Verification {
  at: string;
  variant: string | null;
  quantity: number;
  expectedTotal: string;
  paidTotal: string | null;
  orderId: string | null;
  captureId: string | null;
  orderStatus: string | null;
  linkIdOnOrder: string | null;
  variantOnOrder: string | null;
  screenshot: string | null; // path under /runs
  webhook: { eventId: string; at: string } | null;
  ok: boolean;
  problems: string[];
  durationMs: number;
}

export interface MigrationRow {
  button: DetectedButton;
  recon: Reconstruction | null;
  status: RowStatus;
  link: { id: string; url: string; createdAt: string; request: unknown } | null;
  verification: Verification | null;
  error: string | null;
  diff: { field: string; old: string; new: string }[];
}

export interface Migration {
  id: string;
  createdAt: string;
  scan: ScanResult;
  rows: MigrationRow[];
  isDemo: boolean;
  sourceHtml?: string; // pasted HTML, kept for the patched download
}
