STEADY HANDS OPERATIONS — LEADS

This build connects the lead app to Supabase while keeping localStorage as an offline/local cache.

SUPABASE PROJECT
Project URL is already configured in js.js.
The browser-safe publishable key is already configured in js.js.
Never put an sb_secret_ or service_role key in js.js.

ONE-TIME DATABASE UPDATE
Open Supabase -> SQL Editor and run the contents of supabase-migration.sql.
This adds the tag and last_called columns used by the existing app.

LOGIN
Create your app user in Supabase -> Authentication -> Users.
Open the app and sign in with that user's email/password.
Do not hard-code the user's password into the app.

SYNC BEHAVIOR
- Existing leads already saved on the phone/browser are uploaded to Supabase after the first successful login.
- Supabase then becomes the shared source of lead data across devices.
- Changes made in the app are saved locally immediately and synced to Supabase.
- leads.json can still be used for import when the app opens.

IMPORTANT ABOUT CLOSED-APP JSON IMPORTING
A browser app cannot process a local/hosted leads.json while it is fully closed. To import leads.json while the app is closed, use a server-side importer (for example a GitHub Action or Supabase Edge Function). That is the next optional step after the Supabase connection is tested.
