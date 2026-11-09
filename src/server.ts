// Last Button web server. Right now: health check and the PayPal webhook receiver
// used by spike 3. The scanner, migration and verification routes come next.
import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

interface SeenEvent {
  receivedAt: string;
  id: string;
  event_type: string;
  resource_type?: string;
  resource_id?: string;
  summary?: string;
}
// Keep only non-personal fields, and only the most recent 50.
const seen: SeenEvent[] = [];

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/api/paypal/webhook", (req, res) => {
  const e = req.body ?? {};
  const item: SeenEvent = {
    receivedAt: new Date().toISOString(),
    id: e.id,
    event_type: e.event_type,
    resource_type: e.resource_type,
    resource_id: e.resource?.id,
    summary: e.summary,
  };
  seen.unshift(item);
  seen.length = Math.min(seen.length, 50);
  console.log("webhook", item.event_type, item.resource_id);
  res.sendStatus(200);
});

app.get("/api/paypal/webhook/recent", (_req, res) => res.json(seen));

app.get("/", (_req, res) => {
  res.type("text/plain").send("Last Button: under construction.");
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Last Button listening on :${port}`));
