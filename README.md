# SpamCallStop

Landing page and conversion funnel for SpamCallStop, a phone number removal service.

## Pages
- `index.html` — landing page (hero + free scan)
- `scan-results.html` — scan results (simulated in this build)
- `offer.html` — plan / offer
- `checkout.html` — checkout (prototype, no real charges)
- `thank-you.html` — confirmation
- `terms.html`, `privacy.html` — legal
- `styles.css` — shared styles

## Deploy (GitHub Pages)
Settings -> Pages -> Build and deployment -> Source: "Deploy from a branch" -> Branch: `main` -> Folder: `/ (root)` -> Save.
Live at `https://USERNAME.github.io/REPO/` within a minute or two.

## Update the live site
Edit a file, then:
    git add -A && git commit -m "your message" && git push

Static site, no build step. Relative links, so it works on a Pages subpath or a custom domain.
