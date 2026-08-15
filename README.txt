STEADY LEADS

This version is set up as an installable Progressive Web App (PWA).

Files:
- index.html
- css.css
- js.js
- manifest.webmanifest
- sw.js
- icons/
- clients-empty.json

Important:
The app must be served over HTTPS (or localhost) for installation/service-worker features to work.
Opening index.html directly with file:// will still show the site, but it will not install as an app.

On iPhone/iPad:
Open the hosted site in Safari -> Share -> Add to Home Screen.

On Android/Chrome/Desktop Chrome:
Open the hosted site -> Install app / Add to Home Screen.

AUTO-LOADING LEADS
Edit or replace leads.json in this folder. When the app opens or refreshes, it automatically merges new leads from that file. Existing saved leads are not overwritten. Duplicate phone numbers (or matching name/company/site when no phone exists) are skipped.
