# Bid Connector — BidNet Direct + Euna → your CRM

Pulls solicitations from your **BidNet Direct** vendor profile and your **Euna
(Bonfire) supplier portal** accounts, normalizes them into one record shape, and
pushes deadline events into a custom CRM.

The point is not to mirror the portals. It is to make sure a submission deadline
never moves without your CRM knowing — including the case that actually costs
bids, where an addendum quietly shifts a due date two weeks out.

No runtime dependencies. Node 20+.

---

## Start here: how data gets in

Neither portal publishes a supplier-facing API. BidNet Direct's only documented
API is an internal ConstructConnect integration, and Euna's supplier side offers
no public feed. So this connector reads the channels a registered vendor already
controls, in descending order of how well they hold up:

| Mode | What it reads | Credentials | Notes |
|---|---|---|---|
| `email` | The notification mail both portals send to your vendor profile | none | **Recommended.** Nothing to break when a site is redesigned, and addendum notices arrive here first. |
| `csv` | A saved-search / bid-opportunity export you download from the portal | none | Good for backfilling everything you are already watching. |
| `http` | An authenticated or public portal page | session cookie | Off by default. Check your account terms before enabling; keep `rateLimitMs` generous. |

Most setups want `email` as the spine and `csv` for an initial backfill.

### Wiring up the mail drop

Point a mail rule at a directory of `.eml` files:

- **Gmail / Google Workspace** — filter on `from:bidnetdirect.com` and
  `from:bonfirehub.com`, apply a label, and sync that label down with
  `getmail`, `offlineimap` or `mbsync` writing to `inbox/bidnet` and `inbox/euna`.
- **Outlook / Microsoft 365** — a rule moving those senders to a folder, exported
  by a scheduled Power Automate flow or a local `.eml` drop.
- **Anything else** — auto-forward to an address whose mailbox you can drop to
  disk. The connector only cares that `.eml` files land in the directory.

Processed messages move to `archive` (default `inbox/_processed`), and only after
a successful parse — a parser bug never eats the original.

---

## Setup

```bash
cd connector
cp connector.config.example.json connector.config.json
cp .env.example .env          # then fill in CRM_API_TOKEN
node bin/connector.js doctor  # validates config, paths and credentials
```

Before pointing it at the CRM, confirm what the adapters actually pull out of
**your** mail — templates vary by agency:

```bash
node bin/connector.js inspect path/to/a-real-notification.eml --source bidnet
```

That prints the full normalized record and warns when a deadline could not be
parsed. If a field comes back empty, add the label your agency uses to the
relevant list in `connector.config.json` (see [Tuning](#tuning-the-extraction)) —
no code change needed.

Then a dry run, which writes nothing and touches no CRM:

```bash
node bin/connector.js run --dry-run
```

When that looks right:

```bash
node bin/connector.js run
```

### Scheduling

Hourly is plenty; deadlines move in days, not minutes.

```cron
0 * * * * cd /srv/bid-connector && /usr/bin/node bin/connector.js run >> run.log 2>&1
```

State lives in `.state/solicitations.json`, so whatever runs it must keep that
directory between runs. `run` exits non-zero if any source failed, so a scheduler
can alert on a partial run.

---

## Connecting your CRM

The CRM is a bespoke system, so nothing is hard-coded. The `map` block says which
of your CRM's fields takes which value from the event:

```json
{
  "id": "crm",
  "type": "crm-http",
  "url": "https://crm.example.com/api/v1/bid-events",
  "authEnv": "CRM_API_TOKEN",
  "constants": { "pipeline": "Public Bids" },
  "map": {
    "external_id": "solicitation.id",
    "name": "solicitation.title",
    "due_date": "solicitation.closesAt",
    "due_date_display": "{solicitation.closesAtLocal} {solicitation.timeZone}",
    "note": "reason"
  }
}
```

- Values are **dot paths** into the event, or `{a} {b}` **templates** when your
  CRM wants several fields combined.
- `constants` are merged into every payload.
- `batch: true` posts one `{ records: [...] }` body; `false` posts one per event.
- Fields the event does not carry are omitted rather than sent as null.

Upsert on **`solicitation.id`** — it is stable across every channel, so the same
bid seen by email and by CSV export lands on one CRM record.

Failed deliveries retry with backoff on 5xx/429 and fail loudly on 4xx (a 4xx
means your mapping is wrong; retrying just re-sends the same bad payload).
Delivery is at-least-once, so make your endpoint idempotent on `external_id`
plus `event_type`.

### Events

| Event | Fires when |
|---|---|
| `solicitation.discovered` | First sighting of a bid |
| `solicitation.deadline_changed` | The close date moved — carries `previousClosesAt` and `shiftDays` |
| `solicitation.addendum` | An addendum notice arrived |
| `solicitation.closing_soon` | A lead-time threshold was crossed |
| `solicitation.closed` | The deadline passed |
| `solicitation.updated` | Title, agency, status or URL changed |

`alertLeadDays` defaults to `[21, 14, 7, 3, 1]`. Only the **tightest** crossed
threshold fires, so a connector that was offline for a week sends one "3 days
left", not the whole ladder. A moved deadline re-arms the ladder against the new
date.

---

## How deadlines are handled

This is the part worth understanding, because it is where a bid gets lost.

- **Wall time, then zone.** Portals publish `2:00 PM ET`. That is stored as an
  absolute instant computed through the real IANA zone, so DST is right on both
  sides of a transition — `2:00 PM ET` is 18:00Z in October and 19:00Z in January.
- **Assumptions are marked, not hidden.** If no timezone was published, the
  record carries `timeZoneAssumed: true` and uses `config.timezone`. If only a
  date was published, `closeTimeAssumed: true` and the instant is anchored to
  local **midnight** — deliberately a floor, so alerts fire early rather than
  treating a closed bid as open. Surface both flags in your CRM.
- **Newer wins.** Each record carries `observedAt` from the notification's own
  `Date` header. Mail drops are read in filename order, and an addendum rarely
  sorts after the original it supersedes, so sightings are applied oldest-first
  and a stale re-read can never roll a deadline back.
- **Thin sources do not erase rich ones.** A CSV row is sparser than the
  notification email for the same bid; empty incoming values never overwrite
  populated stored ones, and addenda counts only accumulate.

---

## Tuning the extraction

Every label list is overridable per source. If an agency writes "Bids Shall Be
Received By" instead of "Closing Date":

```json
{
  "id": "bidnet-email",
  "type": "bidnet",
  "mode": "email",
  "inbox": "./inbox/bidnet",
  "closeLabels": ["Bids Shall Be Received By", "Closing Date", "Close Date"]
}
```

Overridable: `closeLabels`, `questionLabels`, `preBidLabels`, `titleLabels`,
`agencyLabels`, `numberLabels`, `linkPattern`.

Use `inspect` to check the result before the next scheduled run.

---

## Commands

```
run [--dry-run] [--config <path>] [--verbose]   ingest, diff, deliver
doctor [--config <path>]                        validate config; touches nothing
inspect <file.eml|file.csv> --source bidnet|euna  show what one file yields
list [--config <path>] [--days <n>]             tracked bids by deadline
```

## Tests

```bash
npm test    # 37 tests, no dependencies
```

Covers DST correctness on both sides of a transition, the spring-forward gap,
quoted-printable and RFC 2047 mail decoding, both adapters against realistic
fixtures, the stale-sighting regression, alert de-duplication, and CRM mapping.

## Layout

```
bin/connector.js      CLI
src/time.js           deadline parsing and timezone math
src/schema.js         canonical Solicitation record
src/events.js         change detection and alerting
src/pipeline.js       the run loop
src/store.js          JSON state (dedup, fired alerts)
src/parse/            MIME, CSV and HTML readers
src/sources/          bidnet, euna adapters
src/sinks/            crm-http, jsonl, console
```

## Limits worth knowing

- The email and HTML extraction was built against representative fixtures, not
  against a live capture of your account's mail. Run `inspect` on real messages
  before trusting the first scheduled run — that is what it is for.
- `http` mode replays a browser session cookie because no supplier API exists.
  Sessions expire (the connector fails loudly with a clear message rather than
  silently reporting zero bids), and portal ToS may restrict automated access.
  Email and CSV modes have neither problem.
- State is a single JSON file. Fine for the thousands of solicitations a
  supplier tracks; not intended as a multi-writer datastore.
