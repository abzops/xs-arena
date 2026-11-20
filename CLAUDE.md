# XS Arena

## Done means proven
1. Before you say "done" or "fixed", run /verify and show me its report with the screenshots. Passing tests alone is not done: walk the real flow in the browser.
2. If a check fails, fix it and run the check again. After 3 failed rounds, stop and ask me. Tell me what fails, what you tried and your best guess at the cause. Don't start a 4th round on your own.
3. Never edit a test, a check or the verify skill to make it pass. If you think the check itself is wrong, stop and tell me why.

## Triggers
- Touched pricing or billing? Check the bill total on the bill sheet and the receipt, and run `scripts/db-test.sh`.
- Changed a migration? Run `scripts/db-test.sh` before applying it to Supabase.
- Changed the floor map or designer? Check the live floor and the TV view in /verify.
