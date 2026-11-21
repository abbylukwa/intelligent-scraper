# Intelligent Scraper

Parallel image album scraper with temp storage.

## Endpoints

- `GET /status` – health check
- `POST /search` – search images on pornpics/darknaija
- `POST /album` – download album (returns albumId)
- `GET /album/:albumId/next` – get next image from album
- `GET /gif?q=...` – search GIFs on hardgif.com
- `POST /cleanup` – force manual cleanup

## Deployment

Push to GitHub, deploy on Render as Web Service.
