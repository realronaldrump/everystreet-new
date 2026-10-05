---
name: log-gas-fillup
description: Log Davis's gas fill-up in Every Street from odometer, gas pump, price, or receipt photos. Always use Marquise, the Nissan, without asking which car. Applies to photo-based fuel logging and corrections to an unsaved fill-up draft, not general driving analysis.
---

# Log Marquise's fill-up

Use the connected **Every Street** app at `https://www.everystreet.me/mcp`.
Marquise, the Nissan Murano, is implied for every gas-logging request. The server
resolves its vehicle record; never choose another vehicle or ask for an IMEI/VIN.

1. Call `get_fuel_logging_context` for recent entries, units, and account timezone.
2. Read the attached images visually. For local image files, view them first.
   Combine photos of the same fill-up into one entry. Use the final pump display,
   not an intermediate pumping screen. Do not combine different fill-ups.
3. Extract the **total odometer miles** (not trip meter/range), **US gallons**,
   **total paid in USD**, and **USD per gallon**. A pump's small final 9 is a tenth
   of a cent: `$3.59` plus `9/10` means `$3.599/gal`. Two known pump values may
   determine the third; identify a calculated value as such. Preserve displayed
   precision (usually three decimals for gallons/unit price, two for dollars).
4. Try to recover the date/time from the original files. In ChatGPT, call
   `inspect_fuel_photos` with original attachments when available; it reads EXIF
   that the vision model cannot see. In local Codex, use the installed ExifTool:

   ```sh
   exiftool -j -DateTimeOriginal -OffsetTimeOriginal -GPSDateTime <original-photo-paths>
   ```

   Prefer the receipt's transaction timestamp, then the completed pump photo's
   capture time, then the odometer photo's capture time. Compare timestamps
   across photos so old or unrelated images are not mixed. Never substitute
   upload time, file creation/modification time, or today's date. If EXIF is
   absent, use a visible receipt date or the owner's stated date. Resolve a
   missing offset using the known transaction location/timezone; the account
   timezone is context, not proof of where a traveling owner bought gas. If the
   date/time or timezone remains uncertain, ask one short question covering all
   missing information. Do not install tools to inspect photos.
5. Assume **full tank** unless the owner says **partial** or **top-up**. If
   intervening fill-ups were missed, set `missed_previous=true`. If the readings
   imply implausible MPG, clarify missing fills rather than invent fuel economy.
6. A request to log gas, or submission of fill-up photos in an established gas
   logging conversation, authorizes saving the assembled entry. Call
   `log_gas_fillup` with a `fillup` object containing `fillup_time` (ISO 8601 with
   offset), `time_source` (`photo_metadata`, `receipt`, or `user`), `gallons`,
   `odometer`, at least `total_cost` or `price_per_gallon`, and the tank flags.
   Let the host handle its write-tool approval. For a read-only/photo-reading
   request, present the readings without saving. Do not use coverage-action
   preparation tools for gas logging.
7. Report **saved** only after a successful result with the stored fill-up ID.
   Keep the reply short: Marquise, local date/time, odometer, gallons, total,
   unit price, and full/partial. Report MPG only when returned by the app. An
   `already_logged` result means no duplicate was created. A mismatch error
   needs corrected readings or a brief clarification; never retry with guessed
   values, bypass the app's validation, or edit an existing record automatically.

Original images are inspected transiently, not added to the vehicle's fuel log.
No passwords, signed file URLs, database queries, or raw vehicle identifiers
belong in the reply. If the app's new tools are missing, refresh the Every Street
connection and open a new conversation; do not claim the draft is logged.
