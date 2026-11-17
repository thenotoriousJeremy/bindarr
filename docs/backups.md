# Backups

Everything is in one SQLite file (`DB_PATH`, in the `bindarr-data` volume under Docker). Binder artwork is in `binder-art/` beside it.

## Automatic backups

Bindarr backs up the database every 24 hours while running, into `backups/` beside it, and keeps the last 10. Each backup is integrity-checked before it's kept. **Admin → Database Backup** lists them and takes one on demand. `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS` and `BACKUP_KEEP_LAST` change where, how often and how many.

Before an upgrade changes the database schema, Bindarr also saves `pre-migration-bindarr-<old>-to-<new>-<time>.bak` (the newest 3 are kept). To roll an upgrade back, restore that file and run the older release.

## A copy off the server

Stop the container first, so the database is fully written to one file:

```bash
docker stop bindarr
docker run --rm -v bindarr-data:/data -v "$PWD":/backup alpine cp /data/bindarr.db /backup/
docker start bindarr
```

To restore, copy the file back into the volume with the container stopped.

## Account backups

Each user can export their own account from **Settings → Collection Backup & Data → Export full backup**: cards and where each copy sits, decks, notes, sealed product, and deals with people outside Bindarr. **Import Backup** restores it on this server or another one, replacing what the account holds. It's also how a collection moves from the phone app to a server. Trades between members aren't included: they belong to both accounts.

## Lost the admin password

```bash
docker exec -it bindarr node scripts/reset-password.js admin
```

It prints a new random password (or set `-e NEW_PASSWORD=...`), signs that account out everywhere, and works for any username. Outside Docker, run `node scripts/reset-password.js <username>` in `backend/`. `DEFAULT_ADMIN_PASSWORD` doesn't change an existing account.
