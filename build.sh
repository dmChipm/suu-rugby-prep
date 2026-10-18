#!/bin/sh
# Builds index.html, the installable online app: app.html (shared with the preview) plus
# the shared-database settings and the sign-in library. The preview runs app.html alone as a local demo.
cd "$(dirname "$0")"
SUPABASE_URL="https://qjzwafkobntrglqcwctj.supabase.co"
SUPABASE_KEY="sb_publishable_OaI_tVT3pxfQ6w0EAZ37NQ_8BUjr_Zz"   # publishable key: safe in the browser, access is enforced by database rules
BUILD="${BUILD:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"   # changes with every release; the app compares it to version.txt
APP_URL="${APP_URL:-}"   # set when hosted, e.g. https://dmchipm.github.io/suu-rugby-prep/
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<meta name="theme-color" content="#b5121b">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Rugby Prep">\n'
  printf '<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" href="icon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="icon-192.png">\n'
  printf '<style>html{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>\n'
  printf '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>\n'
  printf '<script>window.RUGBY_CONFIG = { url: "%s", key: "%s", appUrl: "%s" || undefined, build: "%s" };</script>\n' "$SUPABASE_URL" "$SUPABASE_KEY" "$APP_URL" "$BUILD"
  printf '</head>\n<body>\n'
  cat app.html
  printf '\n<script>if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function(){});</script>\n</body>\n</html>\n'
} > index.html
printf "%s\n" "$BUILD" > version.txt
