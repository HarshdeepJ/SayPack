# SayPack

> Unified Model Document (UMD) — proposed MVP specification.
>
> Working name: SayPack. The name can change without changing the product scope.
> This document describes the intended system. Milestone 1 (manual inventory) is implemented; later milestones are not.

See [the Product Requirements Document](PRD.md) for prioritized requirements, system design, failure handling, and release criteria.

## Running locally

Milestone 1 (manual inventory) is implemented. It needs Node.js 22 or later.

```sh
npm install
npm run create-admin -- --email you@example.com --name "Your Name"   # prompts for a password
npm run dev                                                         # http://localhost:3000
```

Sign in as the administrator, then use **Admin** to create users and moves and to assign roles. Administrators see a move's inventory only if they are also a member of it.

| Command | Purpose |
| --- | --- |
| `npm test` | Domain tests against an in-memory database |
| `npm run typecheck` | Generate Next.js route types and run TypeScript |
| `npm run lint` | ESLint |
| `npm run build && npm start` | Production build and server |

Data is stored in `data/saypack.db` (override with `SAYPACK_DB`). Session cookies are `Secure`; browsers accept them on `http://localhost` and over Tailscale HTTPS. To test from another plain-HTTP host, set `SAYPACK_INSECURE_COOKIES=1`. If a proxy rewrites the Host header, list the public origin in `SAYPACK_ALLOWED_ORIGINS` (comma-separated).

Code layout: `migrations/` holds the SQL schema, `src/domain/` the framework-independent business rules and their tests, `src/server/` the HTTP glue, and `src/app/` the pages and route handlers.

## 1. Purpose

SayPack helps packing and moving teams record which items are in which boxes, document their condition, and resolve damage reports while packing or delivery is still in progress.

Movers use earphones and a phone to speak short commands. An AI assistant converts those commands into proposed inventory updates, asks for clarification when needed, and requests photographs when damage is reported. A shared dashboard gives movers, reviewers, and owners access to the same records according to their permissions.

The AI assists with recording and visual assessment. Authorized people decide whether an affected item may proceed, needs repacking, or requires escalation.

## 2. Goals and boundaries

The MVP must:

- Record items and their box assignments through short voice commands or manual entry.
- Show a searchable inventory organized by move, room, and box.
- Preserve condition observations and photographs before packing and at delivery.
- Open a damage incident immediately when a mover reports damage.
- Request evidence and provide an AI assessment without blocking human review.
- Let reviewers record decisions and notify owners through Telegram.
- Tell movers when an affected item is on hold or may proceed.
- Preserve who recorded, changed, or approved each relevant action.
- Work without paid hosting, database, or storage subscriptions.

The MVP does not include continuous always-listening audio, automatic liability decisions, insurance claim processing, payments, route planning, native mobile apps, or guaranteed offline AI operation.

## 3. Budget and operating assumptions

The user has approximately S$10 of Gemini credits and does not want paid platform subscriptions.

- Run the application, database, and photo storage on an existing computer during development and demonstrations.
- Use Gemini only for short submitted audio commands and selected photographs.
- Use device/browser text-to-speech for spoken confirmations where supported.
- Use mock AI responses for ordinary UI development and reserve real API calls for integration testing.
- Keep manual entry available when Gemini is unavailable or the application budget is exhausted.
- Do not assume that a credit balance is eligible for a particular Gemini billing account or model; verify this before enabling real calls.
- Do not promise a number of sessions within S$10. Measure usage against the selected model's current pricing.

Local hosting requires the host computer to stay on. Movers use Android phones with Chrome. Chrome allows microphone access only on HTTPS pages, so the host and participant devices join a Tailscale network (free personal tier). The host serves the app over Tailscale-issued HTTPS certificates. This also gives tailnet members remote access without exposing the app publicly. Owners who are not on the tailnet interact through Telegram.

## 4. Users and permissions

| Role | Responsibilities | Access |
| --- | --- | --- |
| Mover | Select boxes, record items, capture photos, report damage, check holds | Assigned moves; cannot authorize incident resolution |
| Reviewer / backend team | Review evidence, request more photos, record decisions, notify owners | Assigned moves and incident queue |
| Owner | Browse inventory, view relevant evidence, acknowledge or respond | Their own moves only |
| Administrator | Manage users, move membership, settings, and budget limits | Administrative functions |

Owner acknowledgments and reviewer decisions are separate records. An owner response does not automatically release an item hold in the MVP. The reviewer records the operational decision.

All sensitive reads and writes must enforce permissions on the server, including photo downloads and Telegram actions.

## 5. Main workflow

### 5.1 Prepare a move

1. Create a move with source and destination locations.
2. Assign movers, reviewers, and the owner.
3. Create boxes with unique labels within the move; printable QR codes are optional.
4. Start a packing session and select a room and active box.

### 5.2 Record an item

1. The mover presses the microphone button and says: "Blue ceramic vase, box A, no visible damage."
2. Gemini proposes a structured action containing the item description, box, and reported condition.
3. The backend validates the action, permissions, and referenced records.
4. If information is ambiguous or missing, the assistant asks a targeted question and waits for the response.
5. The app reads the proposal back, for example: "Blue ceramic vase, box A, no damage. Confirm?" The mover taps Confirm or Cancel, or says "yes" or "no". The phone's own speech recognition handles that reply, so it uses no Gemini credits.
6. After the mover confirms and the database transaction succeeds, the interface and spoken reply confirm the saved record.
7. Fragile or valuable items require a baseline photograph before packing is marked complete. For other items, baseline photos are optional. Fragile and valuable are flags set by a mover or reviewer; the AI may propose them, but the mover confirms.

An item's stable ID identifies it throughout the move. Descriptions such as "blue vase" are searchable attributes, not unique identifiers.

### 5.3 Report damage

1. The mover says: "There is a dent on this vase."
2. The system resolves the item or asks which item is affected. If it cannot resolve the item, it still opens an incident awaiting item identification.
3. It saves the incident, places the identified item on hold, and queues a reviewer alert immediately.
4. It asks the mover for a photograph.
5. Gemini assesses visible evidence and may request a clearer view or another angle.
6. The reviewer receives the report, available photos, and AI observations in the dashboard.

Missing photographs, unavailable Gemini service, or inconclusive image analysis must not suppress the incident. The rest of the move may proceed unless a reviewer explicitly places the whole move on hold.

### 5.4 Review and decide

1. The reviewer examines the report and any baseline evidence.
2. The reviewer requests additional evidence if necessary.
3. The reviewer sends the relevant report to the owner through Telegram.
4. The owner views the report and can acknowledge it or submit a response.
5. The reviewer records a decision: continue packing, repack, or escalate.
6. The system updates the hold and displays the decision to the mover.

Continue packing releases the affected item's incident hold. Repack keeps the item held until repacking is recorded and the reviewer releases it. Escalation keeps the item held until a later authorized resolution. A separate whole-move hold requires its own explicit release.

Continue and repack require the affected item to be identified. Until it is, the reviewer can only escalate or resolve with a recorded reason.

### 5.5 Check delivery

1. Locate an item through its box or inventory entry.
2. Record its arrival condition and relevant photographs.
3. Display baseline and arrival evidence together.
4. Open a new incident for any reported damage; use the same review process.

## 6. AI responsibilities

The AI may propose actions such as:

- `record_item`
- `assign_item_to_box`
- `record_condition`
- `report_damage`
- `request_clarification`
- `assess_damage_photo`

These are application-defined operations. The backend validates arguments and executes permitted actions; the model does not directly write to the database.

Rules:

- Ask when an item, box, quantity, or instruction is ambiguous.
- Never invent an item identity or box assignment to complete an action.
- Distinguish "mover reported no visible damage" from a visual assessment.
- Describe possible visible damage, limitations, and requests for better evidence.
- Never claim a photograph proves when damage occurred or who caused it.
- Never release holds or approve incident resolutions.
- Say "saved" only after the backend confirms a successful write.
- Treat speech, transcripts, image content, and model output as untrusted input.

## 7. Data model

Use SQLite for the locally hosted MVP. Store photos as files outside the public web directory, with their metadata and associations in the database.

| Entity | Purpose and key fields |
| --- | --- |
| User | ID, display name, login credentials or external identity reference, active status |
| Move | ID, label, source, destination, lifecycle status, timestamps |
| MoveMember | Move ID, user ID, role; defines access within that move |
| Box | ID, move ID, unique label within move, room, lifecycle status |
| PackingSession | ID, move ID, mover ID, active box, room, start/end timestamps |
| Item | ID, move ID, current box ID, description, category, fragile/valuable flags, lifecycle status |
| ConditionObservation | ID, item ID, stage, reported condition, source, recorder, timestamp |
| Photo | ID, file path, media type, size, uploader, timestamp, linked observation or incident |
| DamageIncident | ID, move ID, nullable item ID, report, workflow status, reporter, revision, timestamps |
| EvidenceRequest | ID, incident ID, requester, request text, status, fulfilling photos, timestamps |
| AIAssessment | ID, incident/photo references, observations, limitations, model, timestamp |
| Decision | ID, incident ID, reviewer ID, action, reason, timestamp |
| Hold | ID, move ID, optional item ID, incident reference, reason, creator, release details |
| OwnerResponse | ID, incident ID, owner ID, response, timestamp |
| AuditEvent | Actor, action, record reference, relevant before/after values, timestamp |
| NotificationJob | Event ID, recipient, channel, state, attempts, next retry, lease owner/expiry, last error |
| AIUsage | Request ID, operation, model, reservation status, reserved estimate, available token/usage metadata, reconciled cost, timestamp |
| VoiceProposal | ID, session ID, action ID, validated operation, validated-against revisions, status (pending, confirmed, cancelled, expired), expiry |
| SubmittedAction | Unique client action ID, user/session, payload fingerprint, status, recorded outcome; prevents duplicate writes |

Box, Item, Hold, and incident-related records carry revision numbers for optimistic concurrency.

Relationships:

```text
Move -> MoveMembers
Move -> Boxes -> Items
Move -> PackingSessions
Item -> ConditionObservations -> Photos
Move -> DamageIncidents -> Photos / AIAssessments / Decisions / OwnerResponses
Move or Item -> Holds
Recorded events -> AuditEvents / NotificationJobs
AI requests -> AIUsage
```

An item represents one individually tracked physical object in the MVP. Bulk quantity entry can be added later. Correcting descriptions, conditions, or box assignments must preserve the previous values in history.

## 8. State and decision rules

Keep lifecycle state separate from incident holds.

| Record | Proposed states |
| --- | --- |
| Move | Draft, packing, in transit, delivered, completed |
| Box | Open, sealed, delivered |
| Item | Recorded, packed, delivered |
| Incident | Open, escalated, resolved |
| Evidence request | Open, fulfilled, cancelled |
| Hold | Active, released |
| Notification | Pending, sending, sent, failed |

- Incident reports and notification jobs must be persisted together in one database transaction.
- Item and box changes must belong to the same move.
- Movers can seal and reopen boxes; both actions are audited. A sealed box rejects adding, removing, or editing its items until reopened.
- Outstanding evidence requests and owner notifications are tracked as separate records, so an incident can await both at once; the reviewer queue shows each as a badge.
- An item cannot progress while it or its move has an active hold.
- Resolving one incident must not release holds created by other incidents.
- Retried voice actions must return the earlier result instead of creating duplicate items.
- Notification failures remain visible and retryable.
- AI assessments supplement condition reports; they do not overwrite the mover's report.

## 9. Technical architecture

| Layer | MVP choice | Responsibility |
| --- | --- | --- |
| Frontend | Next.js, React, TypeScript | Mobile packing screen and shared dashboard |
| Styling | Tailwind CSS | Responsive interface |
| Server | Next.js route handlers, Node.js runtime | Thin HTTP layer over framework-independent domain services |
| Domain services | Plain TypeScript modules | Business rules and transactions; dependencies passed in as interfaces |
| Authentication | SQLite sessions, Argon2id password hashing | Login, session revocation, per-move roles |
| Database | SQLite via better-sqlite3, Kysely, SQL migrations | Inventory, workflow, audit history, usage records |
| Evidence storage | Local filesystem | Private photos, with authorized server access |
| Audio capture | Browser microphone APIs (Android Chrome) | Short push-to-talk recordings, sent to Gemini as `audio/webm` (Opus) |
| Proposal confirmation | Tap controls plus browser speech recognition | Yes/no confirmation without a Gemini call |
| Network access | Tailscale | Trusted HTTPS and remote access for tailnet members |
| AI | Gemini API | Audio interpretation and selected photo assessment |
| Spoken replies | Browser/device speech synthesis | Brief confirmations where supported |
| Dashboard refresh | Periodic polling initially | Fetch committed inventory and incident changes |
| Notifications | Telegram Bot API | Owner reports and links to authorized review screens |
| Notification worker | Local Node.js process | Persistent job polling and bounded retries |

```text
Phone microphone / camera
          |
          v
Next.js interface -> authenticated backend -> Gemini
                              |
                              v
                    SQLite + private photos
                              |
                  +-----------+-----------+
                  |                       |
             Dashboard             Notification worker
                                          |
                                          v
                                    Telegram owner
                                          |
                                          v
                                Recorded owner response
                                          |
                                          v
                                Reviewer decision -> mover
```

Keep Gemini and Telegram secrets on the server in environment variables. Do not commit them or expose them through browser bundles. A future direct-browser Gemini Live connection must use server-issued short-lived credentials supported by the API.

Telegram polling can support the local prototype without an inbound public webhook. Owners must first start or join the bot and have their Telegram identity linked to an authorized move membership. Possessing a Telegram message or incident URL alone must not authorize access or a decision.

## 10. Interface requirements

### Mover screen

- Current move, room, and active box.
- Large push-to-talk control and visible recording state.
- Proposed action, clarification prompts, and saved confirmation.
- Manual item entry and photo capture/upload.
- Clear item holds and reviewer instructions.
- Recent actions for checking and correcting mistakes.

### Shared inventory

- Search by item description, box label, or room.
- Box contents and item details.
- Reported condition, baseline photos, and arrival observations.
- Current incident/hold status and permitted action history.

### Reviewer screen

- Incident queue with items awaiting identification or evidence.
- Side-by-side baseline and incident evidence where available.
- Separate mover report and AI assessment.
- Owner response, decision controls, and explicit hold release.
- Notification delivery and retry status.

### Owner view

- Inventory and evidence for their own moves.
- Relevant incident reports and recorded decisions.
- Acknowledge or respond through the interface or linked Telegram flow.

## 11. Cost controls and failure handling

- Configure the permitted Gemini model, maximum audio duration, photo dimensions, and response size.
- Track request usage and estimated cost using the selected model's current rates.
- Maintain configurable per-session limits and a total application allowance.
- Reserve estimated request cost before dispatch and limit concurrent calls to reduce overshoot.
- Stop new AI calls when the allowance is reached; show the manual-entry fallback.
- Treat the application cutoff as a safeguard, not a provider-enforced billing guarantee. Usage estimates, retries, and pricing changes can affect the final bill.
- Preserve pending notification jobs across process restarts; show exhausted retries to reviewers.
- Clearly show unsaved data if a connection fails. Never present it as a committed record.
- Resume the packing session from stored records after a restart; do not rely on model conversation memory as the inventory.
- Back up the database and photo directory together. A backup must preserve their associations.

## 12. Implementation milestones

1. **Inventory foundation:** users, move membership, boxes, manual item entry, permissions, and shared inventory.
2. **Evidence workflow:** baseline photos, damage reports, holds, reviewer decisions, and audit history.
3. **Voice integration:** mock responses first, then usage limits, short Gemini audio requests, clarification, duplicate protection, and spoken confirmations.
4. **Image assessment:** attach Gemini observations to incidents with an unavailable/inconclusive fallback.
5. **Telegram integration:** owner linking, notifications, acknowledgments, persistent retries, and reviewer visibility.
6. **Delivery and pilot:** arrival observations, evidence comparison, and testing with actual phones and earphones.

## 13. Acceptance criteria

The MVP is ready for a small pilot when:

- A voice command records an item in the intended box and the saved record appears in the shared inventory.
- An ambiguous reference prompts clarification without changing the wrong item.
- Repeating the same submitted action does not create another item.
- Fragile/valuable items cannot be marked packed without the required baseline photo.
- A damage report persists and alerts reviewers even if image analysis fails.
- An item hold prevents further progression until an authorized release.
- Reviewer decisions, owner responses, and their actors/timestamps are preserved.
- Telegram failures retry and are visible without losing the underlying incident.
- Users cannot access another move's inventory, photos, or decisions without membership.
- Manual inventory and review workflows remain usable after the Gemini allowance is exhausted.
- A restart preserves inventory, incidents, holds, and pending notification jobs.
- Phone microphone, camera, and earphone behavior is verified over the intended HTTPS setup.

Measure pilot results using correct box assignments, corrections per item, time to record an item, time to review an incident, notification failures, and AI cost per session.

## 14. Decisions still to validate

- Gemini credit type, eligibility, expiry, selected model, and actual usage cost.
- Specific Android pilot devices, Bluetooth earphones, supported languages, and packing-site noise.
- Photo retention period, backup location, and deletion process.
- Whether a later field pilot needs offline capture or continuous audio.

## 15. Reference documentation

Pricing and service limits can change. Verify them when implementing or changing providers.

- [Next.js documentation](https://nextjs.org/docs)
- [SQLite documentation](https://www.sqlite.org/docs.html)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini billing and credits](https://ai.google.dev/gemini-api/docs/billing)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram bot platform](https://core.telegram.org/bots)
