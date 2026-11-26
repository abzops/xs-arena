---
name: verify
description: Run XS Arena and walk the counter flow like a real front-desk staff member (sign in, start a game, pause/extend, add a snack, close the bill, see the receipt), with screenshots as proof. Use before saying a task is done or fixed, before every commit, and whenever the user asks "does it work?".
---

# Verify: prove it works, don't say it works

## 1. Start the app
- Build and serve: `npm run build && npx vite preview --port 4173`. Wait for `http://localhost:4173`.
- If it's already running, use it. If the build or server fails, stop: that is a failed check. Report the error.
- If the change touched `supabase/`, also run `scripts/db-test.sh`. A failing DB test is a failed check.

## 2. Walk the main flow like front-desk staff
Open the app in a browser (Playwright with Chrome, viewport 1366×860) and do this end to end. Click and type. Don't call Supabase functions directly or skip steps.
1. Open `/login`, sign in as the demo owner (credentials in the session or ask the user). Expect: the centre home page with a heading.
2. Open `/s/xs-arena-demo/floor`, switch to Map. Expect: the floor map with tables, consoles and tracks.
3. Tap a free **Snooker** table. Enter phone `9847012345` (the demo customer "Rahul"), tap `1h`, press `Start 1h`. Expect: the table turns busy with a running timer.
4. Tap the same table. Press `Pause`, then `Resume`, then `+15m`. Expect: `1h 15m booked`.
5. Press `Bill / snacks` → `Snacks & drinks` → add one `Soft drink`. Expect: the bill lists the snooker game and the soft drink with a total in ₹.
6. Choose `UPI`. Expect: a QR code. Then choose `Cash` and press `Close bill`.
7. Expect: the receipt page showing "Rahul" (a known phone keeps its saved name), `In` and `Out` times, the game, the soft drink and the total.
8. Press `Send receipt`. Expect: a receipt **image** is made (since 25 Nov receipts go to WhatsApp as an image, not a link or text): the preview shows the customer name, the game and the total; the short message under it greets the customer; switching to മലയാളം makes the image and the message Malayalam. (Changed with the owner's OK on 26 Nov 2026.)

If the change was in a different area (TV, shift, prices, designer, team), walk that screen too after step 8, the same way, with its own expected result.

## 3. Proof for every step
- Take a screenshot after each step and save it to `verify/step-N.png` (the folder is git-ignored).
- Read the browser console after each step. A red error or uncaught page error is a failed step, even if the page looks fine.
- A step passes only if you saw the expected result on screen.

## 4. Report
Reply with a table: step · pass/fail · screenshot · what you saw.
- All passed: say "verified" and list the screenshots.
- Something failed: fix the cause, then run this whole check again from step 1.
- 3 failed rounds: stop. Tell the user what fails, what you tried, and your best guess at the cause.

## Never
- Never edit a test, this file or any other check to make it pass.
- Never say "done" or "fixed" without this report.
- Never run this against a real customer centre. Only the demo centre.
