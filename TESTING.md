# SayPack manual test script

A walk-through of every feature in milestones 1–4, starting from an empty database with three users. Tick each box as you go; **Expect** lines say what should happen.

## Setup

| Who | Account | Role in the test move |
| --- | --- | --- |
| Admin | `admin@example.com` | Administrator, and **owner** of the move (read-only) |
| Reviewer | `seconduser@example.com` | **Reviewer** |
| Mover | `mover@example.com` | **Mover** (use a phone over Tailscale HTTPS for the voice section) |

Use a separate browser profile or an incognito window for each account so you can stay signed in as all three. Start the app with `npm run dev` (or `npm run build && npm start`).

You will need two or three small JPEG/PNG photos on the phone or computer.

---

## 1. Sign-in and administration (Admin)

- [ ] Sign in with a wrong password. **Expect:** an error, no sign-in.
- [ ] Sign in as admin. Open **Admin**.
- [ ] **New move:** Label `Test move`, From `Old flat`, To `New flat` → **Create move**. **Expect:** "Move created."
- [ ] Under the move, **Add member**: mover → Mover, seconduser → Reviewer, admin → Owner. **Expect:** all three listed with their roles.
- [ ] Add mover as Mover a second time. **Expect:** "This user already has that role in the move."
- [ ] **New user:** create `temp@example.com`, then **Deactivate** it. **Expect:** a "Deactivated" badge. Try to sign in as `temp` in another window. **Expect:** sign-in refused.
- [ ] Look at your own admin row. **Expect:** no Deactivate button (you cannot lock yourself out).
- [ ] **AI usage card** shows `Gemini · gemini-3.5-flash-lite`, S$0 used of S$5.00, 0 requests.

## 2. Rooms, boxes and manual inventory (Mover)

Sign in as mover → **Your moves** → **Pack**.

- [ ] **+ Room** → `Kitchen`. Then **+ Room** → `kitchen`. **Expect:** the second one refused ("already exists").
- [ ] **+ Room** → `Living room`.
- [ ] **+ Box** → label `A`, room Kitchen. **+ Box** → `B`, room Living room. **+ Box** → `a`. **Expect:** the last one refused (labels are case-insensitive).
- [ ] Select Kitchen and box A. Add item `Blue ceramic vase`, tick **Fragile**. **Expect:** "Saved." and it appears in **Your recent actions**.
- [ ] Add `Steel saucepan` (no flags) to box A.
- [ ] Choose **No box (record unboxed)** and add `Table lamp`. **Expect:** saved with no box.
- [ ] Open the saucepan → **Mark packed in box A**. **Expect:** "Marked packed."
- [ ] Open the vase → try to mark it packed. **Expect:** refused: fragile items need a baseline photo.
- [ ] On the vase, **Add baseline photo** (upload a photo). **Expect:** "Photo saved." and the photo shows under Baseline photos. Now **Mark packed**. **Expect:** succeeds.
- [ ] On the vase, **Condition** → Mover report: Existing wear, note `small chip on base` → **Record**. **Expect:** listed under Condition.
- [ ] On the lamp, try to mark it packed. **Expect:** "Put it in a box" message. Use **Move to box** → A. **Expect:** "Moved."
- [ ] On the lamp, **Edit** the description to `Brass table lamp` → **Save changes**. **Expect:** new text shown; **History** lists the old value.

## 3. Sealing boxes (Mover)

- [ ] With box A active, **Seal box**. **Expect:** "This box is sealed…" and the add-item form is disabled.
- [ ] Try to move the lamp out of box A (Move to box → B). **Expect:** refused while A is sealed.
- [ ] **Reopen box**. **Expect:** adding and editing work again.

## 4. Shared inventory and permissions (all three)

- [ ] As mover, open **Inventory**. Search `vase`, then `kitchen`, then `A`. **Expect:** matching items each time; **Clear filter** resets.
- [ ] As admin (owner), open the move's **Inventory**. **Expect:** items, boxes and photos visible, but no Pack button and no edit controls.
- [ ] As admin, try `/moves/<id>/pack` in the address bar. **Expect:** no packing screen (owners cannot write).
- [ ] Copy a baseline photo's link (open it in a new tab) and paste it into a window that is **not signed in**. **Expect:** no photo (sign-in required).
- [ ] As admin, remove yourself from the move, then reload Inventory. **Expect:** access denied. Add yourself back as Owner.

## 5. Damage report on a known item (Mover → Reviewer)

- [ ] As mover, open the vase → **Report damage** → `Crack on the rim, found while wrapping` → **Save report**. **Expect:** "Damage report saved and the item is on hold."
- [ ] **Add damage photo**. **Expect:** photo attached to the incident.
- [ ] Pack screen shows **Needs attention (1)**; the vase shows **⛔ On hold — do not pack**.
- [ ] Try to seal box A. **Expect:** refused: "contains an item on hold".
- [ ] As reviewer, open **Review**. **Expect:** the incident in the **Unresolved** tab, with mover report, baseline photo and damage photo side by side.
- [ ] **Ask for more evidence** → `Close-up of the rim in daylight` → **Send request**. **Expect:** an "open" request.
- [ ] As mover, open the incident → **Upload requested photo**. **Expect:** the request becomes "fulfilled".
- [ ] As reviewer, choose **Repack** with instruction `Re-wrap with extra bubble wrap`. **Expect:** "Decision recorded."; the vase stays on hold.
- [ ] As mover, open the incident → **Record repacking done**. **Expect:** "Repack recorded."; still on hold.
- [ ] As reviewer, **Release hold and resolve**. **Expect:** the incident moves to **Resolved**; the vase is no longer on hold; box A can be sealed.

## 6. Damage report with no item (Mover → Reviewer)

- [ ] As mover, on the Pack screen use **Report damage (not sure which item)** → `Something rattles in box B` → **Save report**. **Expect:** "A reviewer will identify it."
- [ ] As reviewer, open it. **Expect:** no Continue or Repack buttons, only "Continue and repack need the item identified…" with Escalate and Close (no item).
- [ ] Under **Which item is damaged?**, search `saucepan` → **This one**. **Expect:** "Item identified and put on hold."
- [ ] Choose **Continue packing**. **Expect:** the hold is released and the incident resolved.
- [ ] Report another unidentified damage, then as reviewer try **Escalate** then **Close (no item)**: the button stays disabled until you type a reason; with a reason it resolves.

## 7. Whole-move hold (Reviewer → Mover)

- [ ] As reviewer, on Review → **Hold the whole move** with reason `Waiting for owner`. **Expect:** "Move put on hold."
- [ ] As mover, the Pack screen shows **⛔ Whole move on hold**. Try **Mark packed** on an item and **Seal box**. **Expect:** both refused.
- [ ] As reviewer, **Release whole-move hold** with a reason. **Expect:** "Hold released."; mover can continue.

## 8. Voice with Gemini (Mover, on the phone)

Each command makes a real Gemini call (a fraction of a cent). Select box A first.

- [ ] Panel shows **Gemini · S$… left**. Leave **Spoken replies** ticked.
- [ ] Tap **🎤 Tap to speak** and say "Green glass bowl, fragile, no visible damage", then tap to send. **Expect:** "Thinking…", then a readback spoken aloud ("Record Green glass bowl, fragile, box A, no visible damage. Say yes or no.").
- [ ] Say **"yes"**. **Expect:** "Saved: Green glass bowl in box A." spoken; the item appears in the inventory.
- [ ] Say "Wooden chopping board" and answer **"no"**. **Expect:** "Cancelled. Nothing was saved."
- [ ] Say "Spoon, box B" while box A is active. **Expect:** a question about which box (A or B), and nothing saved.
- [ ] Say "Move the brass lamp to box B" → tap **Yes, save**. **Expect:** lamp moves to box B.
- [ ] Say "The lamp has existing wear, a dent on the base" (record condition). **Expect:** readback, confirm, condition recorded.
- [ ] Record two items both called "mug" (e.g. "Red mug", "Blue mug"), then say "move the mug to box B". **Expect:** a clarifying question "Which one do you mean…". Tap **🎤 Tap to answer** and say "the red one". **Expect:** proposal for the red mug only.
- [ ] Say "There's a dent on the green glass bowl". **Expect:** damage readback mentioning the hold; after yes, an incident opens and the bowl is on hold.
- [ ] Get a proposal, wait more than 2 minutes, then tap **Yes, save**. **Expect:** "That proposal expired. Nothing was saved."
- [ ] Get a proposal, switch the active box, and check the proposal is gone (nothing saved).
- [ ] Untick **Spoken replies** and type `Paper towels, box A` in the text field → **Send**. **Expect:** silent readback with buttons only.
- [ ] Say something unrelated ("What's the weather?"). **Expect:** "Not saved. I can record an item, move an item…"
- [ ] Block microphone permission in Chrome and tap the mic. **Expect:** "Microphone access was blocked…"; typing still works.
- [ ] As admin, check the **AI usage** card: **Requests** count rose by the number of commands sent; cost is a few tenths of a cent.

## 8b. AI photo check (Mover, on the phone)

Each photo check is a real Gemini call (about S$0.001).

- [ ] Say "There's a crack on the green glass bowl" → **yes**. **Expect:** "Saved… Please take a photo." and a **Take a photo of the damage** button under it.
- [ ] Photograph something actually damaged (a chipped mug, a cracked case). **Expect:** "Checking the photo with AI…", then a card **AI: damage visible** with a one-line summary, read aloud, ending "A reviewer will decide."
- [ ] Report damage on an undamaged item and photograph it clearly. **Expect:** **AI: no damage seen**, and the item **still on hold** (the AI never releases holds).
- [ ] Take a dark or blurry photo. **Expect:** **AI: photo unclear** with "Better photo needed: …" and the button now says **Take another photo**. Retake → a new check.
- [ ] 💻 Reviewer queue shows the AI badge on the incident. Open it: **AI photo check** lists every check (newest first) with model, photo count and "+ baseline" when the item had a baseline photo.
- [ ] 💻 Reviewer still decides as usual (Continue / Repack / Escalate); the AI badge does not change the hold.
- [ ] Report damage via the form (**Report damage**) and add a photo there. **Expect:** the same automatic check.
- [ ] Reviewer asks for more evidence; mover uploads the requested photo. **Expect:** it is checked automatically too.
- [ ] Press **Check photos with AI again** five times on one incident. **Expect:** the sixth try is refused ("checked 5 times").
- [ ] 💻 Admin AI usage card: request count and cost include the photo checks.

## 9. AI budget guard (Admin + Mover)

- [ ] As admin, set **Allowance (S$)** to the current used amount (e.g. `0.01`) → **Save AI settings**. **Expect:** "Allowance used up" badge.
- [ ] As mover, reload Pack. **Expect:** voice replaced by "The AI allowance is used up. Use manual entry below."; manual item entry still works.
- [ ] Report damage and add a photo. **Expect:** "Photo saved. No AI check: The AI allowance is used up… A reviewer will look at the photo." The incident and photo are still there.
- [ ] Try a negative allowance or a rate of `10`. **Expect:** refused.
- [ ] Set the allowance back to `5` and the rate to the current USD→SGD rate. **Expect:** voice available again.

## 10. Practice mode (optional, no Gemini)

In `.env.local` set `SAYPACK_AI_PROVIDER=mock`, restart the app.

- [ ] Panel shows **Practice mode** and the admin card **Mock (no charges)**.
- [ ] Type `Blue vase, box A, fragile, no visible damage`, `move blue vase to box B`, `damage blue vase: crack on rim`. **Expect:** proposals as in section 8.
- [ ] Type `simulate error` three times. **Expect:** "unavailable" messages, then voice paused for a minute ("Voice is paused after repeated AI errors"). It returns by itself after 60 s.
- [ ] Type `simulate garbage`. **Expect:** "The assistant's answer couldn't be used. Nothing was saved."
- [ ] Type `simulate timeout`. **Expect:** after 30 s, "No answer from the assistant…"; admin card shows 1 "outcome unknown".
- [ ] Report damage with the text `simulate unclear` and add any photo. **Expect:** "Simulated check: … too unclear" plus a retake request. With `simulate no damage`: "no damage visible". Anything else: "damage visible".

Set `SAYPACK_AI_PROVIDER=gemini` again and restart when done.

## 11. Connection loss and duplicates (Mover)

- [ ] In Chrome DevTools (Network → Offline), add an item. **Expect:** an "unsent" status with **Retry**, and it is not shown as saved.
- [ ] Go back online and tap **Retry**. **Expect:** saved once; no duplicate item in the inventory.

## 12. Audit, restart and backup (Admin, on the host)

- [ ] Open any edited item → **History**. **Expect:** who did what and when, with old and new values.
- [ ] Stop the app (`Ctrl+C`) and start it again. **Expect:** all items, incidents and holds still there; you may need to sign in again only if the session expired.
- [ ] With the app running, `npm run backup`. **Expect:** a new `backups/<timestamp>/` folder with the database, photos and a manifest listing counts.
- [ ] Stop the app and run `npm run restore -- backups/<timestamp>`. **Expect:** it refuses if the app is still running; otherwise it moves current data aside and restores.
- [ ] `npm run sweep-photos`. **Expect:** reports 0 orphaned files (or removes crash leftovers older than an hour).

## Automated checks

```sh
npm test          # domain tests
npm run typecheck
npm run lint
npm run gemini-check -- "Blue vase, box A, fragile, no visible damage"   # one real Gemini call, outside the app's allowance
```
