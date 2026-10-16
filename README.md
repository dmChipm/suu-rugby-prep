# SUU Rugby Prep

Game and event preparation checklists for SUU Women's Rugby. Coaches, officers, players and volunteers sign in with their email and a password, or an emailed link, and work from shared game sheets.

- `app.html` is the whole app. Opened on its own it runs as a local demo with example data.
- `build.sh` wraps it into `index.html`, the installable online version connected to the shared database.
- `supabase/` holds the database tables, permission rules and starting data.
- Pushing to `main` publishes the site with GitHub Pages (`.github/workflows/pages.yml`).
